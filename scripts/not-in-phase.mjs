// Prints an honest "not built yet" message for a scripts-contract command whose phase has not
// started (docs/09) and exits 0 so the contract names stay stable for CI (docs/17 section 2).
const [, , name, phase] = process.argv;
process.stdout.write(`${name}: not built yet; planned for ${phase}. Nothing was run.\n`);
