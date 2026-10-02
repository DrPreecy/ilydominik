import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/engine/state-store.js';
import { NextStepEngine } from '../src/guidance/next-step-engine.js';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('Cognitive Work System - Core State Machine & Guardrails', () => {
  it('initializes default state in EXPLORATION phase', () => {
    const store = StateStore.createDefault('proj-1', 'Test Cognitive Project');
    const state = store.getState();

    assert.equal(state.id, 'proj-1');
    assert.equal(state.phase, 'EXPLORATION');
    assert.equal(state.knowledge.length, 0);
    assert.equal(state.assumptions.length, 0);
    assert.equal(state.decisions.length, 0);
  });

  it('records knowledge, unknowns, and assumptions correctly', () => {
    const store = StateStore.createDefault('proj-2', 'Epistemic Test');

    store.dispatch({
      type: 'ADD_KNOWLEDGE',
      payload: {
        id: 'k1',
        claim: 'Users struggle with prompting anxiety and cognitive overload.',
        epistemicType: 'FACT',
        source: 'User interview / initial brief',
      },
    });

    store.dispatch({
      type: 'ADD_UNKNOWN',
      payload: {
        id: 'u1',
        question: 'Which prompting pattern produces the least cognitive friction?',
        status: 'OPEN',
        priority: 'CRITICAL',
      },
    });

    store.dispatch({
      type: 'ADD_ASSUMPTION',
      payload: {
        id: 'a1',
        statement: 'Pre-made prompt files (.prompt.md) eliminate prompt formulation friction completely.',
        riskLevel: 'HIGH',
        status: 'UNTESTED',
      },
    });

    const state = store.getState();
    assert.equal(state.knowledge.length, 1);
    assert.equal(state.unknowns.length, 1);
    assert.equal(state.assumptions.length, 1);
    assert.equal(state.assumptions[0].status, 'UNTESTED');
  });

  it('enforces Anti-Rationalization Guard: Non-human cannot make decisions', () => {
    const store = StateStore.createDefault('proj-3', 'Guardrail Test');

    assert.throws(
      () => {
        store.dispatch({
          type: 'RECORD_DECISION',
          payload: {
            id: 'd1',
            title: 'Use GraphQL instead of REST',
            optionsConsidered: ['GraphQL', 'REST'],
            selectedOption: 'GraphQL',
            rationale: 'AI decided GraphQL is more flexible.',
            // @ts-expect-error Testing non-human decision rejection
            decidedBy: 'AI_AGENT',
          },
        });
      },
      (err: Error) => {
        return err.message.includes('AR_NON_HUMAN_DECISION');
      }
    );
  });

  it('enforces Anti-Rationalization Guard: Blocks transition to IMPLEMENTATION with untested fatal assumptions', () => {
    const store = StateStore.createDefault('proj-4', 'Circuit Breaker Test');

    store.dispatch({
      type: 'ADD_ASSUMPTION',
      payload: {
        id: 'a-fatal',
        statement: 'Third party API provides real-time streaming without rate limits.',
        riskLevel: 'FATAL',
        status: 'UNTESTED',
      },
    });

    assert.throws(
      () => {
        store.dispatch({
          type: 'TRANSITION_PHASE',
          payload: {
            targetPhase: 'IMPLEMENTATION',
            rationale: 'Rushing to code without proof.',
          },
        });
      },
      (err: Error) => {
        return err.message.includes('AR_PREMATURE_IMPLEMENTATION');
      }
    );
  });

  it('allows transition to IMPLEMENTATION once fatal assumption is proven and validated', () => {
    const store = StateStore.createDefault('proj-5', 'Validation Pass Test');

    store.dispatch({
      type: 'ADD_ASSUMPTION',
      payload: {
        id: 'a-high',
        statement: 'Node 24 native test runner handles TypeScript imports via tsx seamlessly.',
        riskLevel: 'HIGH',
        status: 'UNTESTED',
      },
    });

    // Validate with empirical proof
    store.dispatch({
      type: 'VALIDATE_ASSUMPTION',
      payload: {
        id: 'a-high',
        status: 'VALIDATED',
        evidence: 'Executed benchmark suite on Node 24 with tsx, 100% test pass in 150ms.',
      },
    });

    const stateAfterValidation = store.getState();
    assert.equal(stateAfterValidation.assumptions[0].status, 'VALIDATED');
    assert.equal(stateAfterValidation.knowledge.length, 1);

    // Now transition to IMPLEMENTATION succeeds
    store.dispatch({
      type: 'TRANSITION_PHASE',
      payload: {
        targetPhase: 'IMPLEMENTATION',
        rationale: 'Core technical assumption empirically proven.',
      },
    });

    assert.equal(store.getState().phase, 'IMPLEMENTATION');
  });

  it('NextStepEngine generates friction-free copy-paste prompt when fatal assumption is untested', () => {
    const store = StateStore.createDefault('proj-6', 'NextStep Test');

    store.dispatch({
      type: 'ADD_ASSUMPTION',
      payload: {
        id: 'a-ui',
        statement: 'Users prefer slash commands over form dropdowns.',
        riskLevel: 'HIGH',
        status: 'UNTESTED',
      },
    });

    const guidance = NextStepEngine.generateGuidance(store.getState());
    assert.ok(guidance.length > 0);

    const proofRec = guidance.find((g) => g.targetEpistemicTarget === 'ASSUMPTION');
    assert.ok(proofRec);
    assert.ok(proofRec.suggestedPrompt.startsWith('/proof-spike'));
    assert.ok(proofRec.suggestedPrompt.includes('Users prefer slash commands over form dropdowns.'));
  });

  it('persists and reloads project state to disk', async () => {
    const testDir = path.join(process.cwd(), 'sessions', 'test-run');
    const testFile = path.join(testDir, 'state.json');

    const store = StateStore.createDefault('proj-disk', 'Persistence Test', testFile);
    store.dispatch({
      type: 'ADD_KNOWLEDGE',
      payload: {
        id: 'k-disk',
        claim: 'State is durable across session restarts.',
        epistemicType: 'FACT',
        source: 'Automated test suite',
      },
    });

    await store.save();

    const loadedStore = await StateStore.loadFromFile(testFile);
    const loadedState = loadedStore.getState();

    assert.equal(loadedState.id, 'proj-disk');
    assert.equal(loadedState.knowledge.length, 1);
    assert.equal(loadedState.knowledge[0].claim, 'State is durable across session restarts.');

    // Cleanup test artifacts
    await fs.rm(testDir, { recursive: true, force: true });
  });
});
