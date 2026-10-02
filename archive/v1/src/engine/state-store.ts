import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectState, WorkEvent, Phase } from '../models/types.js';
import { AntiRationalizationGuard } from './anti-rationalization.js';

export class StateStore {
  private state: ProjectState;
  private readonly storageFilePath?: string;

  constructor(initialState: ProjectState, storageFilePath?: string) {
    this.state = initialState;
    this.storageFilePath = storageFilePath;
  }

  /**
   * Factory to create an initial state S_0
   */
  public static createDefault(id: string, title: string, storageFilePath?: string): StateStore {
    const initialState: ProjectState = {
      id,
      title,
      phase: 'EXPLORATION',
      knowledge: [],
      unknowns: [],
      assumptions: [],
      decisions: [],
      constraints: [],
      progress: {
        currentObjective: 'Externalize raw thoughts and clarify the problem space.',
        activeWorkstream: 'Discovery',
        completedMilestones: [],
        healthSignal: 'GREEN',
      },
      updatedAt: new Date().toISOString(),
    };

    return new StateStore(initialState, storageFilePath);
  }

  public getState(): Readonly<ProjectState> {
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Deterministic State Transition Function: S_{t+1} = T(S_t, W_t)
   */
  public dispatch(event: WorkEvent): ProjectState {
    const violation = AntiRationalizationGuard.validate(this.state, event);
    if (violation) {
      throw new Error(`[ANTI-RATIONALIZATION VIOLATION: ${violation.code}] ${violation.message} Remedy: ${violation.requiredRemedy}`);
    }

    const now = new Date().toISOString();
    const next: ProjectState = JSON.parse(JSON.stringify(this.state));

    switch (event.type) {
      case 'ADD_KNOWLEDGE':
        next.knowledge.push({
          ...event.payload,
          recordedAt: now,
        });
        break;

      case 'ADD_UNKNOWN':
        next.unknowns.push({
          ...event.payload,
          recordedAt: now,
        });
        break;

      case 'RESOLVE_UNKNOWN': {
        const item = next.unknowns.find((u) => u.id === event.payload.id);
        if (!item) {
          throw new Error(`Unknown with id "${event.payload.id}" not found.`);
        }
        item.status = 'ANSWERED';
        next.knowledge.push({
          id: `kn-${Date.now()}`,
          claim: event.payload.resolutionAnswer,
          epistemicType: 'FACT',
          source: `Resolved unknown: ${item.question}`,
          recordedAt: now,
        });
        break;
      }

      case 'ADD_ASSUMPTION':
        next.assumptions.push({
          ...event.payload,
          recordedAt: now,
        });
        break;

      case 'VALIDATE_ASSUMPTION': {
        const item = next.assumptions.find((a) => a.id === event.payload.id);
        if (!item) {
          throw new Error(`Assumption with id "${event.payload.id}" not found.`);
        }
        item.status = event.payload.status;
        if (event.payload.status === 'VALIDATED') {
          next.knowledge.push({
            id: `kn-${Date.now()}`,
            claim: `Validated assumption: ${item.statement}`,
            epistemicType: 'FACT',
            source: `Evidence: ${event.payload.evidence}`,
            confidence: 0.95,
            recordedAt: now,
          });
        }
        break;
      }

      case 'RECORD_DECISION':
        next.decisions.push({
          ...event.payload,
          recordedAt: now,
        });
        break;

      case 'ADD_CONSTRAINT':
        next.constraints.push(event.payload);
        break;

      case 'TRANSITION_PHASE':
        next.phase = event.payload.targetPhase;
        next.progress.completedMilestones.push(`Transitioned to ${event.payload.targetPhase}: ${event.payload.rationale}`);
        break;

      case 'UPDATE_PROGRESS':
        next.progress = {
          ...next.progress,
          ...event.payload,
        };
        break;
    }

    next.updatedAt = now;
    this.state = next;
    return this.getState();
  }

  /**
   * Persist state to JSON disk file if configured
   */
  public async save(): Promise<void> {
    if (!this.storageFilePath) return;
    const dir = path.dirname(this.storageFilePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.storageFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  /**
   * Load state from JSON disk file
   */
  public static async loadFromFile(filePath: string): Promise<StateStore> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const state: ProjectState = JSON.parse(raw);
    return new StateStore(state, filePath);
  }
}
