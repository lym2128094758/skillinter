export function validate(schema, value, path = '$') {
  const errors = [];
  function visit(rule, item, location) {
    if (rule.anyOf && !rule.anyOf.some(option => validate(option, item, location).length === 0)) { errors.push(`${location}: no matching schema`); return; }
    if (rule.enum && !rule.enum.includes(item)) errors.push(`${location}: unsupported value`);
    if (rule.type === 'object') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${location}: object required`); return; }
      for (const key of rule.required ?? []) if (!Object.hasOwn(item, key)) errors.push(`${location}.${key}: required`);
      for (const [key, child] of Object.entries(item)) {
        if (Object.hasOwn(rule.properties ?? {}, key)) visit(rule.properties[key], child, `${location}.${key}`);
        else if (rule.additionalProperties === false) errors.push(`${location}.${key}: unknown field`);
      }
    } else if (rule.type === 'array') {
      if (!Array.isArray(item)) { errors.push(`${location}: array required`); return; }
      if (item.length < (rule.minItems ?? 0) || item.length > (rule.maxItems ?? Infinity)) errors.push(`${location}: invalid length`);
      item.forEach((child, index) => visit(rule.items, child, `${location}[${index}]`));
    } else if (rule.type === 'integer' || rule.type === 'number') {
      if (typeof item !== 'number' || !Number.isFinite(item) || (rule.type === 'integer' && !Number.isInteger(item)) || item < (rule.minimum ?? -Infinity) || item > (rule.maximum ?? Infinity)) errors.push(`${location}: invalid number`);
    } else if (rule.type && typeof item !== rule.type) errors.push(`${location}: ${rule.type} required`);
    if (typeof item === 'string' && (item.length < (rule.minLength ?? 0) || item.length > (rule.maxLength ?? Infinity))) errors.push(`${location}: invalid string length`);
    if (typeof item === 'string' && rule.pattern && !new RegExp(rule.pattern).test(item)) errors.push(`${location}: invalid string pattern`);
  }
  visit(schema, value, path);
  return errors.slice(0, 20);
}

export const string = {type: 'string', maxLength: 1000};
export const object = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});
