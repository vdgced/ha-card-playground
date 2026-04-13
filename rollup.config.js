import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import replace from "@rollup/plugin-replace";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

export default {
  input: "src/ha-card-playground.ts",
  output: {
    file: "dist/ha-card-playground.js",
    format: "es",
    sourcemap: false,
  },
  plugins: [
    replace({
      preventAssignment: true,
      __VERSION__: JSON.stringify(pkg.version),
    }),
    resolve(),
    typescript({
      tsconfig: "./tsconfig.json",
    }),
    terser({
      format: { comments: false },
    }),
  ],
};
