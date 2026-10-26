import { SPACE_GROUP_DATA } from './space-group-data.js';

const compact = value => String(value ?? '').replace(/[\s_]/g, '').replaceAll('−', '-').toLowerCase();
// Hall token boundaries are semantic: P 32 is a screw axis, P 3 2 has two
// generators. Removing whitespace would confuse different space groups.
const hallKey = value => String(value ?? '').trim().replace(/\s+/g, ' ').replaceAll('−', '-').toLowerCase().replaceAll('=', '"').replaceAll('^', "'");
const settingKey = value => compact(value);
export const SPACE_GROUP_SETTINGS = Object.freeze(SPACE_GROUP_DATA.map(([hallNumber, number, setting, hallSymbol, shortName, fullName, operations]) =>
  Object.freeze({ hallNumber, number, setting, hallSymbol, shortName, fullName, operations: Object.freeze(operations) })));
const fail = message => { throw new Error(`CIF space group: ${message}`); };

/** Resolve the declared coordinate setting, never a guessed conventional one.
 * An IT number alone cannot choose monoclinic axes, rhombohedral axes or origin.
 * Explicit CIF operators remain authoritative and do not call this resolver. */
export function resolveSpaceGroup({ number = null, name = null, hall = null, setting = null } = {}) {
  if (number !== null && (!Number.isInteger(number) || number < 1 || number > 230)) fail('number must be between 1 and 230.');
  let declaredName = name;
  const suffix = typeof name === 'string' && name.match(/^(.*):([^:]+)$/);
  if (suffix) {
    declaredName = suffix[1];
    if (setting && settingKey(setting) !== settingKey(suffix[2])) fail('the symbol suffix and coordinate setting disagree.');
    setting = suffix[2];
  }
  if (!number && !declaredName && !hall && !setting) return SPACE_GROUP_SETTINGS[0];
  let matches = SPACE_GROUP_SETTINGS;
  if (number) matches = matches.filter(entry => entry.number === number);
  if (hall) matches = matches.filter(entry => hallKey(entry.hallSymbol) === hallKey(hall));
  if (declaredName) {
    const key = compact(declaredName);
    matches = matches.filter(entry => compact(entry.shortName) === key || compact(entry.fullName) === key);
  }
  if (setting) matches = matches.filter(entry => settingKey(entry.setting) === settingKey(setting));
  if (!matches.length) fail('the declared number, symbol and coordinate setting are unknown or inconsistent; provide explicit symmetry operators.');
  if (matches.length > 1) {
    // Three Hall symbols in the 530-setting table have duplicate metadata
    // aliases (e.g. Ccca/Cccb) but exactly the same generator group. An explicit
    // Hall declaration already fixes every operation, so these are safe. This
    // exception never guesses a setting from a bare IT number or HM symbol.
    const operations = JSON.stringify([...matches[0].operations].sort());
    if (!hall || matches.some(entry => JSON.stringify([...entry.operations].sort()) !== operations)) {
      fail(`ambiguous coordinate setting (${matches.map(entry => entry.setting || 'standard').join(', ')}); provide a Hall symbol, an explicit coordinate setting, or explicit symmetry operators.`);
    }
  }
  return matches[0];
}
