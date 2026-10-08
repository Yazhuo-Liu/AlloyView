import { isReservedPropertyName } from './io/external-properties.js';
import {
  bindExpression, createExpressionScope, evaluateExpression, ExpressionError,
  isReservedExpressionName, MAX_EXPRESSION_LENGTH, parseExpression,
} from './expressions.js';

/** Computed properties are recipes of a name, a unit and expression text.
 * Their values are derived for each frame and never saved in configurations,
 * so a shared recipe is parsed again by the safe expression parser. */
export const MAX_COMPUTED_PROPERTIES = 64;
export const COMPUTED_PROPERTY_KIND = 'expression';
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_UNIT_LENGTH = 32;

export function isComputedProperty(property) { return property?.analysisKind === COMPUTED_PROPERTY_KIND; }

/** Names are expression identifiers, so later expressions can use them unquoted. */
export function validateComputedPropertyName(value, existingNames = []) {
  if (typeof value !== 'string') throw computedError('Property names must be text.');
  const name = value.trim();
  if (!name) throw computedError('Enter a property name.');
  if (name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
    throw computedError(`Use up to ${MAX_NAME_LENGTH} letters, digits, underscores or dots, starting with a letter or underscore (for example vonMises or stress.vm).`);
  }
  if (isReservedExpressionName(name)) throw computedError(`“${name}” is a built-in expression variable. Choose another name.`);
  if (isReservedPropertyName(name)) throw computedError(`“${name}” is reserved for an input or calculated field. Choose another name.`);
  if (existingNames.some(existing => existing.toLowerCase() === name.toLowerCase())) throw computedError(`A property named “${name}” already exists. Choose another name.`);
  return name;
}

export function validateComputedPropertyUnit(value = '') {
  if (typeof value !== 'string' || value.length > MAX_UNIT_LENGTH || /[\x00-\x1f\x7f]/.test(value)) {
    throw computedError(`Units must be printable text of at most ${MAX_UNIT_LENGTH} characters.`);
  }
  return value.trim();
}

/** Strict, data-free recipe. Every expression must parse, and each one may
 * use only computed properties defined before it. */
export function normalizeComputedPropertyState(value = {}) {
  record(value, 'state', ['properties']);
  const entries = value.properties ?? [];
  if (!Array.isArray(entries) || entries.length > MAX_COMPUTED_PROPERTIES) throw computedError(`Recipes support up to ${MAX_COMPUTED_PROPERTIES} computed properties.`);
  const names = [];
  const properties = entries.map((entry, index) => {
    record(entry, `properties[${index}]`, ['name', 'unit', 'expression']);
    const name = validateComputedPropertyName(entry.name, names);
    const unit = validateComputedPropertyUnit(entry.unit ?? '');
    const expression = validateExpressionText(entry.expression, name);
    names.push(name);
    return { name, unit, expression };
  });
  checkReferences(properties);
  return { properties };
}

function validateExpressionText(expression, name) {
  // Line breaks and tabs are whitespace; other control characters are rejected.
  if (typeof expression !== 'string' || expression.length > MAX_EXPRESSION_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(expression)) {
    throw computedError(`“${name}” needs expression text of at most ${MAX_EXPRESSION_LENGTH} characters.`);
  }
  try { parseExpression(expression); }
  catch (error) { throw computedError(`“${name}”: ${error.message}`); }
  return expression;
}

/** Evaluation follows list order, so a reference to the same or a later
 * property would be a cycle or a forward reference. */
function checkReferences(properties) {
  const order = new Map(properties.map((property, index) => [property.name.toLowerCase(), index]));
  properties.forEach((property, index) => {
    for (const reference of parseExpression(property.expression).references) {
      const target = order.get(reference.name.toLowerCase());
      if (target === undefined || target < index) continue;
      throw computedError(target === index ? `“${property.name}” cannot refer to itself.`
        : `“${property.name}” refers to “${properties[target].name}”, which is defined after it. A computed property can use only properties listed above it.`);
    }
  });
}

/** Parsed definitions for repeated frame application. */
export function compileComputedProperties(state) {
  return normalizeComputedPropertyState(state).properties.map(property => Object.freeze({
    ...property, key: JSON.stringify([property.name, property.unit, property.expression]), parsed: parseExpression(property.expression),
  }));
}

/** Replace a frame's computed columns in definition order. Unchanged inputs
 * (compared by array identity) keep the previous property object, so repeated
 * refreshes neither reallocate values nor invalidate statistics snapshots.
 * A definition whose variables are missing in this frame waits rather than
 * failing; one whose name a column already uses reports a conflict. */
export function applyComputedProperties(frame, definitions, cache = new WeakMap()) {
  if (!frame?.properties) return { changed: false, statuses: [] };
  const base = frame.properties.filter(property => !isComputedProperty(property));
  let entries = cache.get(frame);
  if (!entries) cache.set(frame, entries = new Map());
  const used = new Set(), added = [], statuses = [];
  for (const definition of definitions) {
    const conflict = base.find(property => property.name?.toLowerCase() === definition.name.toLowerCase());
    if (conflict) {
      statuses.push({ name: definition.name, state: 'conflict', message: `This frame already has a property named “${conflict.name}”. Rename the computed property.` });
      continue;
    }
    let bound;
    try { bound = bindExpression(definition.parsed, createExpressionScope(frame, { properties: [...base, ...added] })); }
    catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      statuses.push({ name: definition.name, state: 'waiting', message: error.message });
      continue;
    }
    const previous = entries.get(definition.key);
    let property = previous && previous.inputs.length === bound.inputs.length
      && previous.inputs.every((input, index) => Object.is(input, bound.inputs[index])) ? previous.property : null;
    if (!property) {
      property = { name: definition.name, unit: definition.unit, data: evaluateExpression(bound),
        analysisKind: COMPUTED_PROPERTY_KIND, expression: definition.expression };
      entries.set(definition.key, { inputs: bound.inputs, property });
    }
    used.add(definition.key);
    added.push(property);
    statuses.push({ name: definition.name, state: 'ready' });
  }
  for (const key of [...entries.keys()]) if (!used.has(key)) entries.delete(key);
  const next = [...base, ...added];
  const changed = next.length !== frame.properties.length || next.some((property, index) => property !== frame.properties[index]);
  if (changed) frame.properties = next;
  return { changed, statuses };
}

/** Remove computed columns, for example from cached frames after an edit. */
export function removeComputedProperties(frame) {
  if (!frame?.properties?.some(isComputedProperty)) return false;
  frame.properties = frame.properties.filter(property => !isComputedProperty(property));
  return true;
}

function record(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw computedError(`Invalid ${label}.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw computedError(`Unexpected ${label} key “${key}”.`);
}
function computedError(message) { return new Error(`Computed properties: ${message}`); }
