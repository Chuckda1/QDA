import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const FORBIDDEN_PATTERNS = [
  "Heartbeat: Bot online",
  "waiting for market data",
  /heartbeat/i,
  /setInterval.*heartbeat/i,
  /HEARTBEAT.*push/i,
];

const FORBIDDEN_ENTRYPOINTS = [
  "index_prod.ts",
  "index_golden_prod.ts",
  "index_legacy.ts",
  "oldRunner.ts",
];

function getAllTsFiles(dir: string, fileList: string[] = []): string[] {
  const files = readdirSync(dir);
  files.forEach(file => {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory() && !filePath.includes("node_modules") && !filePath.includes("dist")) {
      getAllTsFiles(filePath, fileList);
    } else if (file.endsWith(".ts")) {
      fileList.push(filePath);
    }
  });
  return fileList;
}

function verify(): void {
  const errors: string[] = [];
  
  // Check for forbidden strings in source files
  const srcFiles = getAllTsFiles("src");
  
  for (const file of srcFiles) {
    const content = readFileSync(file, "utf-8");
    
    for (const pattern of FORBIDDEN_PATTERNS) {
      const regex = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : pattern;
      if (regex.test(content)) {
        errors.push(`Forbidden pattern found in ${file}: ${pattern}`);
      }
    }
  }
  
  // Check for duplicate entrypoints
  const entrypoints = srcFiles.filter(f => f.includes("index") && f.endsWith(".ts"));
  for (const forbidden of FORBIDDEN_ENTRYPOINTS) {
    if (entrypoints.some(e => e.includes(forbidden))) {
      errors.push(`Forbidden entrypoint found: ${forbidden}`);
    }
  }
  
  // Ensure only one entrypoint
  const validEntrypoints = entrypoints.filter(e => e === "src/index.ts");
  if (validEntrypoints.length !== 1) {
    errors.push(`Expected exactly one entrypoint (src/index.ts), found: ${entrypoints.join(", ")}`);
  }
  
  if (errors.length > 0) {
    console.error("❌ Verification failed:");
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }
  
  console.log("✅ Verification passed: No forbidden patterns found.");
}

try {
  verify();
} catch (err) {
  console.error("Verification error:", err);
  process.exit(1);
}
