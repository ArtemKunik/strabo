import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { extractLanguageContracts, findSourceFiles } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-dto-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

const field = (contract, name) => contract.fields.find((entry) => entry.name === name);
const contract = (contracts, id) => contracts.find((entry) => entry.id === id);

test('extractLanguageContracts reads TypeScript interfaces and object type aliases', () => {
  const root = tempDir();
  write(
    root,
    'src/types.ts',
    [
      'export interface User {',
      '  readonly id: string;',
      '  name?: string;',
      '  address: { city: string };',
      '  greet(): void;',
      '}',
      'export type Account = {',
      '  owner: User;',
      '  balance: number;',
      '};',
    ].join('\n'),
  );

  const contracts = extractLanguageContracts(root, 'web');
  const user = contract(contracts, 'User');
  assert.equal(user.format, 'typescript');
  assert.equal(user.repository, 'web');
  assert.equal(user.source, 'src/types.ts');
  assert.equal(field(user, 'id').required, true);
  assert.equal(field(user, 'name').required, false);
  assert.equal(field(user, 'name').type, 'string');
  // `greet` is a method and `address` is a nested object, so neither is a field.
  assert.deepEqual(
    user.fields.map((entry) => entry.name),
    ['id', 'name'],
  );

  const account = contract(contracts, 'Account');
  assert.equal(field(account, 'owner').type, 'User');
});

test('extractLanguageContracts reads Python dataclasses and pydantic models', () => {
  const root = tempDir();
  write(
    root,
    'models.py',
    [
      'from dataclasses import dataclass',
      'from pydantic import BaseModel',
      '',
      '@dataclass',
      'class User:',
      '    id: int',
      '    name: str = "anonymous"',
      '',
      'class Address(BaseModel):',
      '    street: str',
      '    zip: str = ""',
      '',
      'class Helper:',
      '    def run(self):',
      '        pass',
    ].join('\n'),
  );

  const contracts = extractLanguageContracts(root, 'api');
  const user = contract(contracts, 'User');
  assert.equal(user.format, 'python');
  assert.equal(field(user, 'id').required, true);
  assert.equal(field(user, 'name').required, false);
  assert.equal(field(user, 'name').type, 'str');

  const address = contract(contracts, 'Address');
  assert.equal(field(address, 'street').required, true);
  assert.equal(field(address, 'zip').required, false);

  assert.equal(contract(contracts, 'Helper'), undefined);
});

test('extractLanguageContracts reads Kotlin data classes', () => {
  const root = tempDir();
  write(
    root,
    'User.kt',
    ['data class User(', '  val id: Long,', '  var nickname: String? = null,', '  val email: String,', ')'].join(
      '\n',
    ),
  );

  const [user] = extractLanguageContracts(root, 'app');
  assert.equal(user.id, 'User');
  assert.equal(user.format, 'kotlin');
  assert.equal(field(user, 'id').required, true);
  assert.equal(field(user, 'email').required, true);
  assert.equal(field(user, 'nickname').required, false);
  assert.equal(field(user, 'nickname').type, 'String?');
});

test('extractLanguageContracts reads Java and C# records', () => {
  const javaRoot = tempDir();
  write(
    javaRoot,
    'User.java',
    'public record User(String id, int age) {}\n// ignore me\nrecord Ignored() {}',
  );
  const [user] = extractLanguageContracts(javaRoot, 'api');
  assert.equal(user.format, 'java');
  assert.equal(user.repository, 'api');
  assert.equal(field(user, 'id').type, 'String');
  assert.equal(field(user, 'age').required, true);

  const csharpRoot = tempDir();
  write(
    csharpRoot,
    'User.cs',
    'public sealed record User(string Id, string? Nickname = null);',
  );
  const [csUser] = extractLanguageContracts(csharpRoot, 'api');
  assert.equal(csUser.format, 'csharp');
  assert.equal(field(csUser, 'Id').required, true);
  assert.equal(field(csUser, 'Nickname').required, false);
});

test('extractLanguageContracts reads Rust structs and treats Option as optional', () => {
  const root = tempDir();
  write(
    root,
    'user.rs',
    [
      '#[derive(Serialize)]',
      'pub struct User {',
      '  pub id: u64,',
      '  nickname: Option<String>,',
      '  pub(crate) email: String,',
      '}',
      'pub struct Point(i32, i32);',
    ].join('\n'),
  );

  const contracts = extractLanguageContracts(root, 'core');
  const [user] = contracts;
  assert.equal(user.id, 'User');
  assert.equal(user.format, 'rust');
  assert.equal(field(user, 'id').required, true);
  assert.equal(field(user, 'email').required, true);
  assert.equal(field(user, 'nickname').required, false);
  // A tuple struct has no field names, so it is not a contract.
  assert.equal(contract(contracts, 'Point'), undefined);
});

test('findSourceFiles prunes generated directories and non-source files', () => {
  const root = tempDir();
  write(root, 'src/app.ts', 'export interface A { x: string }\n');
  write(root, 'node_modules/dep/index.js', 'export interface Hidden { y: string }\n');
  write(root, 'README.md', 'not source\n');

  const files = findSourceFiles(root);
  assert.deepEqual(files, ['src/app.ts']);
  assert.deepEqual(
    extractLanguageContracts(root, 'repo').map((entry) => entry.id),
    ['A'],
  );
});
