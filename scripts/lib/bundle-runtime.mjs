import { build, version as esbuildVersion } from 'esbuild';
import { parse } from 'acorn';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

function modulePath(path) { return path.replaceAll('\\', '/'); }
function relativeImport(from, to) {
  const path = modulePath(relative(dirname(from), to));
  return path.startsWith('.') ? path : `./${path}`;
}

/** Esbuild moves imported code into an entry's directory. Keep each source
 * module's URL, including dynamic new URL(value, import.meta.url), without
 * changing quoted text, comments, or template literals. */
export function preserveModuleUrls(contents, source, entry) {
  if (source === entry || !contents.includes('import.meta')) return contents;
  const ast = parse(contents, { ecmaVersion: 'latest', sourceType: 'module' });
  const replacements = [], pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'MemberExpression' && !node.computed && node.property?.name === 'url'
        && node.object?.type === 'MetaProperty' && node.object.meta.name === 'import'
        && node.object.property.name === 'meta') {
      replacements.push([node.start, node.end]);
      continue;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) { for (const child of value) if (child?.type) pending.push(child); }
        else if (value.type) pending.push(value);
      }
    }
  }
  const replacement = `new URL(${JSON.stringify(relativeImport(entry, source))}, import.meta.url).href`;
  for (const [start, end] of replacements.sort((left, right) => right[0] - left[0])) {
    contents = contents.slice(0, start) + replacement + contents.slice(end);
  }
  return contents;
}

async function runtimeEntries(root) {
  const entries = ['src/app.js'];
  for (const entry of await readdir(resolve(root, 'src/workers'), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })) {
    if (entry.isFile() && entry.name.endsWith('-worker.js')) entries.push(`src/workers/${entry.name}`);
  }
  try { await readFile(resolve(root, 'src/analysis/gpu/worker.js')); entries.push('src/analysis/gpu/worker.js'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return entries.sort();
}

function sourcePlugin(root, entry, sources) {
  return {
    name: 'original-module-urls',
    setup(builder) {
      builder.onResolve({ filter: /^(?:node:|worker_threads$)/ }, args => ({ path: args.path, external: true }));
      // Emscripten owns its loader and pthread URL. Keep the glue at its
      // original path, with its Wasm beside it, rather than inlining it.
      builder.onResolve({ filter: /\.mjs$/ }, args => ({
        path: relativeImport(entry, resolve(dirname(args.importer || entry), args.path)), external: true,
      }));
      builder.onLoad({ filter: /\.js$/ }, async args => {
        let source = sources.get(args.path);
        if (source === undefined) { source = await readFile(args.path, 'utf8'); sources.set(args.path, source); }
        return { contents: preserveModuleUrls(source, args.path, entry), loader: 'js', resolveDir: dirname(args.path) };
      });
    },
  };
}

async function exportNames(contents, sourcefile) {
  const result = await build({ stdin: { contents, sourcefile }, write: false, bundle: false,
    format: 'esm', metafile: true, logLevel: 'silent' });
  const names = Object.values(result.metafile.outputs)[0].exports;
  const starExports = parse(contents, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .filter(node => node.type === 'ExportAllDeclaration' && !node.exported)
    .map(node => contents.slice(node.start, node.end));
  return { names, starExports };
}

/** One file per actual page/Worker entry. Source-module facades retain the
 * page's class identities for existing integration probes and module imports;
 * they do not add requests to normal page startup. Development and Node tests
 * continue to load the original source files. */
export async function createBrowserBundles(root) {
  const entries = await runtimeEntries(root), sources = new Map(), files = new Map(), summaries = [];
  const options = entry => ({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', keepNames: true,
    minify: false, legalComments: 'inline', metafile: true, logLevel: 'silent',
    plugins: [sourcePlugin(root, resolve(root, entry), sources)] });
  const appEntry = 'src/app.js', app = await build(options(appEntry));
  const modules = Object.keys(app.metafile.inputs).filter(path => path.endsWith('.js') && path !== appEntry)
    .sort().map(path => modulePath(path));
  const facades = await Promise.all(modules.map(async (path, index) => ({ path, index,
    ...await exportNames(sources.get(resolve(root, path)) ?? await readFile(resolve(root, path), 'utf8'), path) })));
  const exports = facades.filter(module => module.names.length || module.starExports.length);
  const entryContents = `import './app.js';\n${exports.map(module =>
    `export * as module_${module.index} from ${JSON.stringify(relativeImport(resolve(root, appEntry), resolve(root, module.path)))};`).join('\n')}\n`;
  const appOptions = options(appEntry); delete appOptions.entryPoints;
  const bundledApp = await build({ ...appOptions, stdin: { contents: entryContents,
    sourcefile: '__alloyview_entry__.js', resolveDir: resolve(root, 'src') } });
  files.set(appEntry, bundledApp.outputFiles[0].contents);
  summaries.push({ entry: appEntry, modules: modules.length + 1, bytes: bundledApp.outputFiles[0].contents.length });
  for (const module of exports) {
    const lines = [`import { module_${module.index} as namespace } from ${JSON.stringify(relativeImport(resolve(root, module.path), resolve(root, appEntry)))};`];
    module.names.forEach((name, index) => {
      lines.push(`const binding_${index} = namespace[${JSON.stringify(name)}];`);
      lines.push(`export { binding_${index} as ${/^[$\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(name) ? name : JSON.stringify(name)} };`);
    });
    lines.push(...module.starExports);
    files.set(module.path, new TextEncoder().encode(`${lines.join('\n')}\n`));
  }
  for (const entry of entries.filter(path => path !== appEntry)) {
    const result = await build(options(entry));
    files.set(entry, result.outputFiles[0].contents);
    summaries.push({ entry, modules: Object.keys(result.metafile.inputs).length, bytes: result.outputFiles[0].contents.length });
  }
  const manifest = { version: 1, bundler: `esbuild ${esbuildVersion}`, entries: summaries, moduleFacades: exports.length };
  files.set('runtime-manifest.json', new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  return { files, manifest };
}
