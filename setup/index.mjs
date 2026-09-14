// Entry point for `npm run setup`. Plain JavaScript on purpose: it checks the Node
// version before loading the TypeScript sources, because an older Node fails on the
// .ts import with a syntax error that explains nothing.

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    [
      '',
      `✖ Setup needs Node.js 22.18 or newer (this is ${process.version}).`,
      '',
      '  What to do: install the current Node.js LTS (winget install OpenJS.NodeJS.LTS),',
      '  open a new terminal, and run `npm run setup` again.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const { main } = await import('./setup.ts');
process.exitCode = await main(process.argv.slice(2));
