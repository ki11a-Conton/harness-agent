import type { LearningCandidate } from "@ar/learning";
export interface JsonlCandidateStoreOptions {
    dataDir: string;
}
export declare const CANDIDATES_FILE_NAME = "learning-candidates.jsonl";
/** Minimal surface the reflection runner / CLI promoter need. */
export interface LearningCandidateStore {
    list(): Promise<LearningCandidate[]>;
    get(id: string): Promise<LearningCandidate | undefined>;
    add(candidate: LearningCandidate): Promise<void>;
    update(candidate: LearningCandidate): Promise<void>;
    remove(id: string): Promise<void>;
}
export declare class JsonlCandidateStore implements LearningCandidateStore {
    private readonly file;
    private loaded;
    private candidates;
    constructor(opts: JsonlCandidateStoreOptions);
    list(): Promise<LearningCandidate[]>;
    get(id: string): Promise<LearningCandidate | undefined>;
    add(candidate: LearningCandidate): Promise<void>;
    update(candidate: LearningCandidate): Promise<void>;
    remove(id: string): Promise<void>;
    private load;
    private persist;
    private lockKey;
}
//# sourceMappingURL=candidate-store.d.ts.map