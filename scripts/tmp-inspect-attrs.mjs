import { withParser } from '../src/scan/languages/parser-runtime.ts';

const source = [
  '#[cfg(test)]',
  '#[path = "discovery_tests.rs"]',
  'mod tests;',
  '',
  '#[cfg(test)]',
  'mod plain;',
  '',
  'mod sibling;',
].join('\n');

await withParser('rust', (parser) => {
  const tree = parser.parse(source);
  for (const node of tree.rootNode.namedChildren) {
    console.log(node.type, JSON.stringify(node.text), 'line', node.startPosition.row + 1);
    for (const child of node.namedChildren) {
      console.log('   child:', child.type, JSON.stringify(child.text));
    }
  }
});
