// Auto-generated example from scripts/embed-standalone-preset.mjs.
// It is rebuilt from scaffold/presets/example-c99 during Bun packaging.
import type { LoadedPreset, PresetManifest } from "./scaffold";

const manifest: PresetManifest = {
  schemaVersion: 1,
  id: "example-c99",
  language: "c",
  standard: "c99",
  headerFile: "exam.h",
  systemHeaders: [],
  components: [
    {
      id: "gcd_u64",
      description: "Greatest common divisor of two unsigned integers",
      symbols: ["exam_gcd_u64"],
      source: "components/gcd_u64.h",
      requires: []
    },
    {
      id: "lcm_u64",
      description: "Least common multiple (unsigned overflow is possible)",
      symbols: ["exam_lcm_u64"],
      source: "components/lcm_u64.h",
      requires: ["gcd_u64"]
    }
  ]
};
const sources = {
  gcd_u64: "/* Example only: unsigned GCD, standard C99. */\nstatic unsigned long long exam_gcd_u64(unsigned long long a, unsigned long long b) {\n    while (b != 0) {\n        unsigned long long remainder = a % b;\n        a = b;\n        b = remainder;\n    }\n    return a;\n}\n",
  lcm_u64: "/* Example only. Caller must ensure the result fits unsigned long long. */\nstatic unsigned long long exam_lcm_u64(unsigned long long a, unsigned long long b) {\n    if (a == 0 || b == 0) return 0;\n    return (a / exam_gcd_u64(a, b)) * b;\n}\n"
};
export function builtinPreset(): LoadedPreset {
  return {
    manifest,
    code: new Map(Object.entries(sources)),
    order: ["gcd_u64", "lcm_u64"]
  };
}
