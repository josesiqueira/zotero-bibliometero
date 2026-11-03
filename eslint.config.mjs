// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      // Runs inside Zotero through the MCP bridge as a function body, so a
      // top-level return is intended.
      ignores: ["test/live/harness.js"],
    },
    {
      // Each test file groups its cases in more than one describe block.
      files: ["test/**/*.ts"],
      rules: { "mocha/max-top-level-suites": "off" },
    },
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
  ],
});
