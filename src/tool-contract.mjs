import { object, validate } from './schema.mjs';

const string = {type: 'string'};
const nil = {enum: [null]};
const errorSchema = object({code: string, message: string});
const noError = Object.freeze({code: 'OK', message: ''});

export function resultSchema(data) {
  return {anyOf: [
    object({ok: {enum: [true]}, data, error: object({code: {enum: ['OK']}, message: {enum: ['']}})}),
    object({ok: {enum: [false]}, data: nil, error: errorSchema}),
  ]};
}

export function success(data) {
  return {ok: true, data, error: noError};
}

export function failure(errors, code) {
  if (!Object.hasOwn(errors, code)) throw new Error('Unregistered tool error: ' + code);
  return {ok: false, data: null, error: {code, message: errors[code]}};
}

export function checkResult(definition, value) {
  if (validate(definition.returns, value).length) throw new Error('Tool result schema mismatch: ' + definition.name);
  if (!value.ok && definition.errors[value.error.code] !== value.error.message) {
    throw new Error('Tool result error mismatch: ' + definition.name);
  }
  return value;
}
