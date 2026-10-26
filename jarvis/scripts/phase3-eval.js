'use strict';

const { runPhase3Suite } = require('../core/evals/phase3-suite');
const { runRealModelSuite } = require('../core/evals/real-model-suite');

function compactResult(result) {
  return {
    name: result.name,
    category: result.category,
    status: result.status,
    completed: result.completed,
    errorCode: result.errorCode,
    steps: result.steps,
    durationMs: result.durationMs,
    validToolCalls: result.validToolCalls,
    invalidToolCalls: result.invalidToolCalls,
    approvals: result.approvals,
    mutatingCalls: result.mutatingCalls,
    unapprovedMutations: result.unapprovedMutations,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const real = args.has('--real');
  const json = args.has('--json');

  if (real) {
    const models = (process.env.JARVIS_EVAL_MODELS || process.env.JARVIS_EVAL_MODEL || 'llama3.1:8b')
      .split(',')
      .map(model => model.trim())
      .filter(Boolean);
    const result = await runRealModelSuite({
      models,
      baseUrl: process.env.JARVIS_OLLAMA_URL || undefined,
      numCtx: Number(process.env.JARVIS_EVAL_NUM_CTX || 4096),
      numPredict: Number(process.env.JARVIS_EVAL_NUM_PREDICT || 256),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const measurement of result.models) {
        console.log(`\n${measurement.model}`);
        if (measurement.error) {
          console.log(`  error: ${measurement.error}`);
          continue;
        }
        console.log(`  completed: ${measurement.completed}/${measurement.tasks} (${Math.round(measurement.completionRate * 100)}%)`);
        console.log(`  task success: ${measurement.successful}/${measurement.tasks} (${Math.round(measurement.successRate * 100)}%)`);
        console.log(`  valid tool calls: ${measurement.validToolCalls}/${measurement.validToolCalls + measurement.invalidToolCalls}`);
        console.log(`  p50/p95: ${measurement.p50LatencyMs}ms / ${measurement.p95LatencyMs}ms`);
        console.log(`  context/tools/vision: ${measurement.capabilities?.contextLength} / ${measurement.capabilities?.tools} / ${measurement.capabilities?.vision}`);
        for (const task of measurement.results) {
          console.log(`    ${task.success ? 'PASS' : 'FAIL'} ${task.task}: ${task.status}${task.errorCode ? ` (${task.errorCode})` : ''}`);
        }
      }
      console.log(`\nRecommended model from measured results: ${result.recommendedModel || 'none'}`);
      console.log(`Real-model gate: ${result.passed ? 'PASS' : 'FAIL'}`);
    }
    process.exitCode = result.passed ? 0 : 1;
    return;
  }

  const result = await runPhase3Suite();
  if (json) {
    console.log(JSON.stringify({
      suite: result.suite,
      scenarioCount: result.scenarioCount,
      metrics: result.metrics,
      targets: result.targets,
      passed: result.passed,
      scenarios: result.results.map(compactResult),
    }, null, 2));
  } else {
    console.log(`Phase 3 fake-model suite: ${result.scenarioCount} scenarios`);
    console.log(`  completion: ${result.metrics.completed}/${result.metrics.tasks} (${Math.round(result.metrics.completionRate * 100)}%)`);
    console.log(`  valid tool calls: ${result.metrics.validToolCalls}/${result.metrics.validToolCalls + result.metrics.invalidToolCalls} (${Math.round(result.metrics.validToolCallRate * 100)}%)`);
    console.log(`  unsafe action rate: ${result.metrics.unsafeActionRate}`);
    console.log(`  silent budget violations: ${result.metrics.silentBudgetViolations}`);
    console.log(`  p50/p95: ${result.metrics.p50LatencyMs}ms / ${result.metrics.p95LatencyMs}ms`);
    console.log(`  categories: ${result.metrics.categories.join(', ')}`);
    for (const resultItem of result.results.filter(item => !item.completed)) {
      console.log(`  expected/non-complete: ${resultItem.name} -> ${resultItem.status}${resultItem.errorCode ? ` (${resultItem.errorCode})` : ''}`);
    }
    console.log(`Phase 3 fake-model gate: ${result.passed ? 'PASS' : 'FAIL'}`);
  }
  process.exitCode = result.passed ? 0 : 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
