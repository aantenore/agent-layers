import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noMappings } from '@agent-layers/core';
import { adapter, createFunctionTools } from '../src/index.ts';
import { ADD_MODULE, ctx, tempModules } from './helpers.ts';

const tool = (name: string, body = `'${name}'`) =>
  `{ name: '${name}', description: '${name}', params: { type: 'object' }, run: () => ${body} }`;

test('a module with a tools array, loaded relative to cwd', async () => {
  const { dir, cleanup } = await tempModules({ 'tools.mjs': ADD_MODULE });
  try {
    const port = await createFunctionTools({ module: './tools.mjs' }, { cwd: dir });
    assert.deepEqual((await port.listTools(ctx())).map((t) => t.name), ['add', 'boom']);
    assert.deepEqual(await port.callTool('add', { a: 2, b: 3 }, ctx()), { ok: true, text: '5' });
    assert.deepEqual(await port.callTool('boom', {}, ctx()), { ok: false, text: 'Error: kaboom' });
  } finally {
    await cleanup();
  }
});

test('default export as a single tool, an array and an object of tools', async () => {
  const { dir, cleanup } = await tempModules({
    'single.mjs': `export default ${tool('one')};`,
    'array.mjs': `export default [${tool('a')}, ${tool('b')}];`,
    'object.mjs': `export default { first: ${tool('x')}, second: ${tool('y')}, ignored: 3 };`,
  });
  try {
    const names = async (m: string) => (await (await createFunctionTools({ module: m }, { cwd: dir })).listTools(ctx())).map((t) => t.name);
    assert.deepEqual(await names('./single.mjs'), ['one']);
    assert.deepEqual(await names('./array.mjs'), ['a', 'b']);
    assert.deepEqual(await names('./object.mjs'), ['x', 'y']);
  } finally {
    await cleanup();
  }
});

test('named exports shaped like tools are collected once, other exports are ignored', async () => {
  const { dir, cleanup } = await tempModules({
    'named.mjs': `const shared = ${tool('shared')};\nexport const tools = [shared];\nexport { shared };\nexport const alone = ${tool('alone')};\nexport const config = { retries: 3 };\nexport function helper() {}`,
  });
  try {
    const port = await createFunctionTools({ module: './named.mjs' }, { cwd: dir });
    assert.deepEqual((await port.listTools(ctx())).map((t) => t.name).sort(), ['alone', 'shared']);
  } finally {
    await cleanup();
  }
});

test('programmatic tools and a module combine; a module without tools fails', async () => {
  const { dir, cleanup } = await tempModules({ 'tools.mjs': ADD_MODULE, 'empty.mjs': 'export const x = 1;' });
  try {
    const local = { name: 'local', description: 'd', params: { type: 'object' }, run: () => 'l' };
    const port = await createFunctionTools({ tools: [local], module: './tools.mjs' }, { cwd: dir });
    assert.deepEqual((await port.listTools(ctx())).map((t) => t.name), ['local', 'add', 'boom']);
    await assert.rejects(createFunctionTools({ module: './empty.mjs' }, { cwd: dir }), /exports no tools/);
    await assert.rejects(createFunctionTools({ module: './missing.mjs' }, { cwd: dir }));
  } finally {
    await cleanup();
  }
});

test('the descriptor creates an instance named after the slot', async () => {
  const { dir, cleanup } = await tempModules({ 'tools.mjs': ADD_MODULE });
  try {
    const port = await adapter.create({ module: './tools.mjs' }, { name: 'local', env: {}, cwd: dir, telemetry: undefined as never, mappings: noMappings() });
    assert.equal(port.name, 'local');
  } finally {
    await cleanup();
  }
});

test('a relative path without ./ is a file when it exists', async () => {
  const { dir, cleanup } = await tempModules({ 'plain.mjs': ADD_MODULE });
  try {
    const port = await createFunctionTools({ module: 'plain.mjs' }, { cwd: dir });
    assert.deepEqual((await port.listTools(ctx())).map((t) => t.name), ['add', 'boom']);
  } finally {
    await cleanup();
  }
});
