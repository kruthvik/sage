// Cram eval units (M3): ≥5 domains, ≥1 non-academic. Kept apart from cram-eval.ts, which runs on import.
export interface Unit { id: string; domain: string; academic: boolean; objective: string; minutes: number; learner: string }
export const UNITS: Unit[] = [
  { id: "calc", domain: "math", academic: true, minutes: 90, objective: "Cram the derivative rules (power, product, chain) for tomorrow's calculus quiz",
    learner: "You know the power rule well. You mix up the product rule (you sometimes multiply the derivatives). You forget the inner derivative in the chain rule about half the time." },
  { id: "resp", domain: "biology", academic: true, minutes: 90, objective: "Cram cellular respiration (glycolysis, Krebs cycle, electron transport chain) for a biology test",
    learner: "You remember glycolysis happens in the cytoplasm. You think the Krebs cycle makes most ATP directly. You are vague about where the electron transport chain is and about oxygen's role." },
  { id: "ww1", domain: "history", academic: true, minutes: 120, objective: "Cram the causes of the First World War for an essay exam",
    learner: "You remember the assassination of Franz Ferdinand and the word 'alliances'. You can't explain militarism or imperialism with specific examples, and you treat the assassination as the only cause." },
  { id: "esp", domain: "language", academic: true, minutes: 90, objective: "Cram when to use the Spanish preterite vs the imperfect for an oral exam (text practice)",
    learner: "You know the preterite endings for -ar verbs. You use the preterite for everything in the past, including descriptions and habits. You don't know the trigger words." },
  { id: "aid", domain: "first aid (non-academic)", academic: false, minutes: 120, objective: "Cram adult CPR and the recovery position before a workplace first-aid assessment",
    learner: "You think CPR is 15 compressions to 2 breaths and you are unsure of the depth. You know to check for breathing but not for how long. You have never seen the recovery position described step by step." },
];
