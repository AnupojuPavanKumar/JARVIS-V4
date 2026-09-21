// JARVIS — Procedural Memory (Phase 5E equivalent)
// Extracts reusable procedures from completed agentic tasks.

window.ProceduralMemory = (() => {
  async function extract(taskSnapshot) {
    if (!taskSnapshot || taskSnapshot.state !== 'COMPLETED' || taskSnapshot.stepCount <= 1) {
      console.log("[Procedural] Task not eligible for extraction.");
      return;
    }

    console.log("[Procedural] Extracting candidate from task:", taskSnapshot.goal);
    if (typeof window.showToast === 'function') {
      window.showToast('Extracting Procedural Memory...', 'info');
    }

    const extractionPrompt = `You are the JARVIS procedural memory extraction engine.
A task has just completed successfully. Evaluate if it contains a REUSABLE PROCEDURE.
A reusable procedure explains HOW to accomplish a general class of tasks step-by-step.

Task Goal: ${taskSnapshot.goal}
Steps taken: ${taskSnapshot.stepCount}

Please output a concise, generalized step-by-step guide on how to perform this task in the future. Avoid mentioning specific timestamps or unique IDs. Make it broadly applicable.`;

    let fullContent = '';
    try {
      await new Promise((resolve, reject) => {
        window.streamOllama([{ role: 'user', content: extractionPrompt }], {
          onChunk: (chunk, full) => { fullContent = full; },
          onDone: (full) => { fullContent = full; resolve(); },
          onError: (err) => { reject(err); }
        });
      });

      console.log("[Procedural] Extraction Result:", fullContent);

      if (window.jarvisMemory) {
        // Use the existing semantic memory engine to store the procedure
        const memoryEntry = `Procedural Memory for [${taskSnapshot.goal}]:\n${fullContent}`;
        await window.jarvisMemory.extractAndStore(memoryEntry);
        window.jarvisMemory.save();
        
        if (typeof window.showToast === 'function') {
          window.showToast('Procedural Memory Saved!', 'success');
        }
      }
    } catch (err) {
      console.error("[Procedural] Extraction failed:", err);
    }
  }

  return { extract };
})();
