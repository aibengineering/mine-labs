/**
 * The knobs an operator can turn while a session is running.
 *
 * A long session is something people watch and steer: skip this trial, jump to
 * that scenario, stop after this one, loop a single test, run only one
 * category. This class is that control surface, deliberately separated from the
 * loop that obeys it so the same controls can be driven from the CLI, from the
 * in-game UI, or from a test, and so a hung trial cannot take the controls down
 * with it.
 *
 * Cancellation is per-trial `AbortController`s under a session-wide one, which
 * is what makes "skip" and "stop" different operations rather than degrees of
 * the same one. The `take*` methods are single-use permits: reading a queued
 * request consumes it, so one click on "run this scenario" runs it once.
 */

export type TrialCancellation = "skip" | "select" | "stop" | "menu";

/** Controls for one scenario session. Safe to expose through a UI or operator API. */
export class SessionController {
  readonly #lifetime = new AbortController();
  readonly #activeTrials = new Map<string, AbortController>();
  #requestedScenario: string | undefined;
  #requestedCount = 0;
  #batchRemaining = 0;
  #selectedCategory: string | undefined;
  #scheduleChanged = false;
  #menuRequested = false;
  #continuousEnabled = true;
  #singleScenarioEnabled = false;
  #jobs = 1;
  readonly #scheduleWaiters = new Set<() => void>();
  readonly #changeListeners = new Set<() => void>();

  /** Read pending work without consuming a selection or batch permit. */
  get pendingSchedule() {
    return { requested: this.#requestedScenario, batch: this.#batchRemaining,
      changed: this.#scheduleChanged, menu: this.#menuRequested };
  }

  onScheduleChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => { this.#changeListeners.delete(listener); };
  }

  #notifyScheduleChange(): void {
    for (const listener of this.#changeListeners) listener();
  }

  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }

  get continuousEnabled(): boolean {
    return this.#continuousEnabled;
  }

  get singleScenarioEnabled(): boolean {
    return this.#singleScenarioEnabled;
  }

  get selectedCategory(): string | undefined {
    return this.#selectedCategory;
  }

  stop(): void {
    if (!this.#lifetime.signal.aborted) this.#lifetime.abort("stop");
    this.#cancelActiveTrials("stop");
    this.#notifyScheduleChange();
    this.#wakeScheduler();
  }

  /** Skip every trial currently occupying a worker. */
  skip(): void {
    this.#cancelActiveTrials("skip");
  }

  get jobs(): number { return this.#jobs; }

  /** Concurrency changes apply to the next batch, without interrupting a trial. */
  setJobs(jobs: number): void {
    if (!Number.isInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive integer");
    this.#jobs = jobs;
    this.#notifyScheduleChange();
    this.#wakeScheduler();
  }

  /** Leave the current world while keeping the catalog and client alive. */
  returnToMenu(): void {
    this.#continuousEnabled = false;
    this.#requestedScenario = undefined;
    this.#requestedCount = 0;
    this.#batchRemaining = 0;
    this.#scheduleChanged = false;
    this.#menuRequested = true;
    this.#cancelActiveTrials("menu");
    this.#notifyScheduleChange();
    this.#wakeScheduler();
  }

  takeMenuRequest(): boolean {
    const requested = this.#menuRequested;
    this.#menuRequested = false;
    return requested;
  }

  /** A refreshed catalog may remove a queued scenario or the selected folder. */
  reconcileCatalog(names: string[], categories: string[]): void {
    if (this.#requestedScenario && !names.includes(this.#requestedScenario)) this.#requestedScenario = undefined;
    if (this.#selectedCategory && !categories.includes(this.#selectedCategory)) {
      this.#selectedCategory = undefined;
      this.#scheduleChanged = false;
    }
    this.#notifyScheduleChange();
  }

  selectScenario(name: string): void {
    this.#requestedScenario = name;
    this.#requestedCount = this.#jobs;
    this.#batchRemaining = 0;
    this.#cancelActiveTrials("select");
    this.#notifyScheduleChange();
    this.#wakeScheduler();
  }

  selectCategory(category: string | undefined): void {
    this.#selectedCategory = category;
    this.#requestedScenario = undefined;
    this.#requestedCount = 0;
    this.#batchRemaining = 0;
    this.#scheduleChanged = true;
    this.#cancelActiveTrials("select");
    this.#notifyScheduleChange();
    this.#wakeScheduler();
  }

  setContinuous(enabled: boolean): void {
    this.#continuousEnabled = enabled;
    if (!enabled) this.#batchRemaining = 0;
    this.#notifyScheduleChange();
    if (enabled) this.#wakeScheduler();
  }

  setSingleScenario(enabled: boolean): void {
    this.#singleScenarioEnabled = enabled;
    this.#notifyScheduleChange();
  }

  takeRequestedScenario(): string | undefined {
    const requested = this.#requestedScenario;
    if (this.#requestedCount > 0) this.#requestedCount--;
    if (this.#requestedCount === 0) this.#requestedScenario = undefined;
    return requested;
  }

  queueBatch(count: number): void { this.#batchRemaining = count; this.#wakeScheduler(); }
  takeBatchPermit(): boolean {
    if (this.#batchRemaining === 0) return false;
    this.#batchRemaining--;
    return true;
  }

  takeScheduleChange(): boolean {
    const changed = this.#scheduleChanged;
    this.#scheduleChanged = false;
    return changed;
  }

  /** Wait while repetition is paused; queued selections and batches can still run. */
  async waitUntilRunnable(workerIndex = 0): Promise<void> {
    while (!this.signal.aborted && (workerIndex >= this.#jobs || (!this.#continuousEnabled && !this.#requestedScenario && !this.#scheduleChanged && !this.#menuRequested && this.#batchRemaining === 0))) {
      await new Promise<void>((resolve) => this.#scheduleWaiters.add(resolve));
    }
  }

  beginTrial(trialId: string): AbortSignal {
    if (this.#activeTrials.has(trialId)) throw new Error(`session controller already owns trial '${trialId}'`);
    const trial = new AbortController();
    if (this.signal.aborted) trial.abort("stop");
    this.#activeTrials.set(trialId, trial);
    return trial.signal;
  }

  finishTrial(trialId: string, signal: AbortSignal): void {
    if (this.#activeTrials.get(trialId)?.signal === signal) this.#activeTrials.delete(trialId);
  }

  #cancelActiveTrials(reason: TrialCancellation): void {
    for (const trial of this.#activeTrials.values()) {
      if (!trial.signal.aborted) trial.abort(reason);
    }
  }

  #wakeScheduler(): void {
    const waiters = [...this.#scheduleWaiters];
    this.#scheduleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}
