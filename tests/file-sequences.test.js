import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catalogLocalSources,
  detectNumberedCfgSequences,
  detectNumberedStructureSequences,
  detectStructureFormatHeader,
  inferStructureFormatFromPath,
  isPotentialStructurePath,
} from '../src/io/file-sequences.js';

test('numbered CFG sequences are detected when the changing number occurs anywhere in the name', () => {
  const sequences = detectNumberedCfgSequences([
    entry('neb12/relax_7_replica.000.cfg'),
    entry('neb12/relax_7_replica.001.cfg'),
    entry('neb12/relax_7_replica.002.cfg'),
  ]);

  assert.equal(sequences.length, 1);
  assert.equal(sequences[0].pattern, 'neb12/relax_7_replica.{number}.cfg');
  assert.deepEqual(sequences[0].entries.map((item) => item.relativePath), [
    'neb12/relax_7_replica.000.cfg',
    'neb12/relax_7_replica.001.cfg',
    'neb12/relax_7_replica.002.cfg',
  ]);
});

test('sequence detection keeps folders separate and records missing indices', () => {
  const sequences = detectNumberedCfgSequences([
    entry('a/replica.0.cfg'),
    entry('a/replica.2.cfg'),
    entry('b/replica.0.cfg'),
    entry('b/replica.1.cfg'),
  ]);

  assert.equal(sequences.length, 2);
  assert.equal(sequences[0].missingCount, 1);
  assert.equal(sequences[1].missingCount, 0);
});

test('content-classified CFG sequences may place the index after a conventional extension', () => {
  const sequences = detectNumberedCfgSequences([
    entry('neb/replica.cfg.0', 'cfg'),
    entry('neb/replica.cfg.1', 'cfg'),
  ]);
  assert.equal(sequences[0].pattern, 'neb/replica.cfg.{number}');
  assert.equal(isPotentialStructurePath('neb/replica.cfg.0'), true);
});

test('underscore indices and numbered LAMMPS dump files form format-specific sequences', () => {
  const sequences = detectNumberedStructureSequences([
    entry('cfg/replica_0.cfg'),
    entry('cfg/replica_1.cfg'),
    entry('dump/snapshot_0.lmp', 'lammps-dump'),
    entry('dump/snapshot_1.lmp', 'lammps-dump'),
  ]);
  assert.deepEqual(sequences.map((sequence) => [sequence.pattern, sequence.format]), [
    ['cfg/replica_{number}.cfg', 'cfg'],
    ['dump/snapshot_{number}.lmp', 'lammps-dump'],
  ]);
});

test('structure headers are identified without relying on filename extensions', () => {
  assert.equal(detectStructureFormatHeader('# generated\nNumber of particles = 5\n'), 'cfg');
  assert.equal(detectStructureFormatHeader('ITEM: TIMESTEP\n0\n'), 'lammps-dump');
  assert.equal(detectStructureFormatHeader('ordinary text'), null);
  assert.equal(detectStructureFormatHeader('2\ncomment\nFe 0 0 0\nC 1 1 1\n'), 'xyz');
  assert.equal(detectStructureFormatHeader('REMARK   generated\nATOM      1  C   MOL A   1       0.000   0.000   0.000\n'), 'pdb');
});

test('CFG filename hints remain valid when a numeric suffix follows the extension', () => {
  assert.equal(inferStructureFormatFromPath('replica.0.cfg'), 'cfg');
  assert.equal(inferStructureFormatFromPath('replica.cfg.0'), 'cfg');
  assert.equal(inferStructureFormatFromPath('trajectory.dump.25'), 'lammps-dump');
  assert.equal(inferStructureFormatFromPath('trajectory_25.lmp'), 'lammps-dump');
  assert.equal(inferStructureFormatFromPath('trajectory.lammpstraj'), 'lammps-dump');
  assert.equal(inferStructureFormatFromPath('trajectory.extxyz.1'), 'xyz');
  assert.equal(inferStructureFormatFromPath('snapshot.xyz'), 'xyz');
  assert.equal(inferStructureFormatFromPath('snapshot.pdb.2'), 'pdb');
  assert.equal(inferStructureFormatFromPath('snapshot.ent'), 'pdb');
});

test('numbered XYZ and PDB files remain homogeneous sequences with natural order', () => {
  const catalog = catalogLocalSources([
    entry('xyz/frame.10.xyz'), entry('xyz/frame.2.xyz'),
    entry('pdb/model.1.pdb'), entry('pdb/model.0.pdb'),
    entry('single.extxyz'),
  ]);
  assert.equal(catalog.sequenceCount, 2);
  assert.equal(catalog.supportedCount, 5);
  assert.deepEqual(catalog.sources.map((source) => source.format), ['pdb', 'xyz', 'xyz']);
  assert.deepEqual(catalog.sources[1].files.map((file) => file.name), ['frame.2.xyz', 'frame.10.xyz']);
  assert.match(catalog.sources[0].detail, /PDB files/);
  assert.match(catalog.sources[1].detail, /XYZ files/);
});

test('an explicitly rejected text file is not restored from its extension hint', () => {
  const catalog = catalogLocalSources([
    { ...entry('log.txt'), format: null },
    entry('replica.0.cfg'),
    entry('replica.1.cfg'),
  ]);
  assert.equal(catalog.supportedCount, 2);
  assert.equal(catalog.sources.length, 1);
});

test('numbered CFG and LAMMPS dump files become separate sequences', () => {
  const catalog = catalogLocalSources([
    entry('replica.0.cfg'),
    entry('replica.1.cfg'),
    entry('dump.0.lammpstrj'),
    entry('dump.1.lammpstrj'),
  ]);

  assert.equal(catalog.sequenceCount, 2);
  assert.deepEqual(catalog.sources.map((source) => source.kind), ['sequence', 'sequence']);
  assert.deepEqual(catalog.sources.map((source) => source.format), ['lammps-dump', 'cfg']);
  assert.equal(catalog.sources[0].files.length, 2);
});

test('explicitly selected non-numbered CFG files retain manual sequence behavior', () => {
  const catalog = catalogLocalSources([
    entry('initial.cfg'),
    entry('saddle.cfg'),
    entry('final.cfg'),
  ], { allowManualCfgSequence: true });

  assert.equal(catalog.sources.length, 1);
  assert.equal(catalog.sources[0].kind, 'sequence');
  assert.equal(catalog.sources[0].detected, false);
});

function entry(relativePath, format) {
  return { file: { name: relativePath.split('/').at(-1), size: 100 }, relativePath, format };
}

test('single-file drops keep numbered and manually selected CFG files independent', () => {
  for (const names of [['replica.0.cfg', 'replica.1.cfg'], ['initial.cfg', 'saddle.cfg']]) {
    const catalog = catalogLocalSources(names.map(name => entry(name)), { singleFiles: true, allowManualCfgSequence: true });
    assert.equal(catalog.sequenceCount, 0);
    assert.equal(catalog.sources.length, 2);
    assert.ok(catalog.sources.every(source => source.kind === 'file' && source.files.length === 1));
  }
});
