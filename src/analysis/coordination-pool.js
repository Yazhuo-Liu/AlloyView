import { AnalysisPool } from './analysis-pool.js';

export { chooseWorkerCount } from './analysis-pool.js';

export class CoordinationPool {
  constructor(pool = new AnalysisPool()) {
    this.pool = pool;
  }

  analyze(frame, cutoff, options) {
    return this.pool.analyze(frame, { kind: 'coordination', cutoff }, options);
  }

  close() {
    this.pool.close();
  }
}
