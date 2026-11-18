import { defineConfig } from 'tsdown'

// Entry points: the library (`.`), the CLI commands the project-local CLI loads
// (package.json `strutvane.commands`) and the installer (`strutvane.installer`). The framework is
// a peer dependency and stays external.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    commands: 'src/commands.ts',
    installer: 'src/installer.ts',
  },
  format: 'esm',
  platform: 'node',
  fixedExtension: true,
  target: 'es2024',
  dts: true,
  sourcemap: true,
  clean: true,
})
