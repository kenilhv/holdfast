import { runEval } from "../src/eval.ts";

const result = runEval();
for (const r of result.rows) console.log(`${r.right ? "ok   " : "WRONG"} ${r.verdict.padEnd(5)} ${String(r.score).padStart(3)}  ${r.fraud ? "fraud" : "clean"}  ${r.name}`);
console.log(`\nCaught ${result.caught} of ${result.fraud} fraud bills. ${result.falseAlarms} false alarms on ${result.clean} clean bills. Bills written by the team.`);
