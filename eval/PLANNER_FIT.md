# Planner budget fit (R&D, terra low reasoning, 2026-11-08)

Question: terra planned the calc Cram (90 min) as 6 nodes / 14 subskills, which the gate prices at 192 min. Does telling the planner what the gate charges fix that?

The hint is computed in code from `gateMinutes` (per-subskill cost and node-check cost for the mode and pace) and ends with a subskill count that fits the budget. Run: `bun packages/eval/experiments/planner-fit.ts openai/gpt-6.1-terra 2` (`ARMS=hint` for one arm). "gate estimate" = the gate's minutes for the plan as produced.

## Before (no hint) vs first hint (average subskill cost)

| unit | arm | budget | gate estimate | fits | nodes | subskills | cost | node titles |
|---|---|---|---|---|---|---|---|---|
| calc | current | 90 | 187 | no | 5 | 14 | 0.0051 | Recognize derivative notation and basic power-rule inputs; Differentiate powers, constants, and sums; Differentiate products; Differentiate composite functions with the chain rule; Choose and combine derivative rules under quiz conditions |
| calc | current | 90 | 166 | no | 5 | 12 | 0.0048 | Recognize derivatives and basic function forms; Apply the power rule and basic linearity; Differentiate products; Differentiate compositions with the chain rule; Choose and combine rules on mixed quiz problems |
| calc | hint | 90 | 100 | no | 3 | 7 | 0.0029 | Apply the power rule; Differentiate products; Differentiate compositions and combine rules |
| calc | hint | 90 | 100 | no | 3 | 7 | 0.0029 | Use the power rule and basic derivative conventions; Differentiate products; Apply the chain rule and combine rules |
| resp | current | 90 | 199 | no | 6 | 18 | 0.0071 | Explain the overall purpose and structure of cellular respiration; Track the inputs and outputs of glycolysis; Connect pyruvate oxidation to the Krebs cycle; Account for Krebs cycle products; Explain electron transport and chemiosmosis; Integrate yields and compare conditions |
| resp | current | 90 | 200 | no | 6 | 18 | 0.0070 | Explain the purpose and overall flow of cellular respiration; Trace glycolysis and its products; Connect pyruvate oxidation to the Krebs cycle; Account for Krebs cycle inputs and outputs; Explain electron transport and chemiosmosis; Integrate yields and predict effects of changed conditions |
| resp | hint | 90 | 84 | yes | 3 | 7 | 0.0034 | Trace glycolysis and pyruvate oxidation; Trace the Krebs cycle and electron transport chain; Connect stages and predict outcomes |
| resp | hint | 90 | 89 | yes | 3 | 7 | 0.0035 | Trace glycolysis and pyruvate oxidation; Trace the Krebs cycle; Explain oxidative phosphorylation and integrate respiration |
| ww1 | current | 120 | 202 | no | 6 | 17 | 0.0067 | Orient the essay around chronology and causal categories; Explain alliances, rivalries, and militarism; Explain nationalism, imperialism, and prewar crises; Trace the July Crisis and escalation to general war; Compare causes and construct a defensible judgment; Plan and write an evidence-led exam response from memory |
| ww1 | current | 120 | 214 | no | 7 | 18 | 0.0071 | Orient the essay around causes and chronology; Explain alliances and diplomatic rivalries; Explain militarism and war planning; Connect nationalism and imperial rivalry to tensions; Trace the July Crisis into European war; Weigh causes and responsibility; Plan and write an evidence-led exam response |
| ww1 | hint | 120 | 103 | yes | 3 | 9 | 0.0050 | Explain the major long-term causes; Trace the July Crisis into a European war; Build a causal essay argument |
| ww1 | hint | 120 | 111 | yes | 3 | 10 | 0.0053 | Explain long-term tensions before 1914; Trace the outbreak of war in 1914; Build a supported causal essay |
| esp | current | 90 | 181 | no | 5 | 14 | 0.0081 | Recognize and produce the two past-tense forms; Choose between completed events and past background; Combine tenses in a past narrative; Interpret meaning changes with common verbs; Draft and check oral-exam responses in text |
| esp | current | 90 | 165 | no | 4 | 13 | 0.0052 | Recognize and form the two past tenses; Choose a tense for a single past situation; Combine tenses in a past narrative; Interpret contrasts and practice exam-style responses |
| esp | hint | 90 | 93 | no | 3 | 7 | 0.0036 | Recognize the two past-tense forms; Choose a tense for the intended past-time meaning; Combine tenses in an oral-exam-style response |
| esp | hint | 90 | 100 | no | 3 | 7 | 0.0046 | Recognize the two past-tense forms; Choose the tense for a past situation; Combine tenses in an exam-style narrative |
| aid | current | 120 | 269 | no | 7 | 22 | 0.0128 | Recognize an emergency and assess responsiveness and breathing; Get help and choose the immediate response; Describe effective adult chest compressions; Describe CPR cycles and rescue breaths; Use an AED alongside CPR; Describe the recovery position and ongoing monitoring; Apply the full response in assessment scenarios |
| aid | current | 120 | 272 | no | 7 | 21 | 0.0124 | Recognize an emergency and summon help; Choose CPR or the recovery position; Describe effective adult chest compressions; Describe the adult CPR cycle; Use an AED alongside CPR; Describe the recovery position and ongoing care; Apply the sequence to workplace assessment scenarios |
| aid | hint | 120 | 125 | no | 3 | 10 | 0.0058 | Recognize an emergency and activate help; Describe adult CPR and AED use; Describe the recovery position and ongoing monitoring |
| aid | hint | 120 | 107 | yes | 3 | 8 | 0.0039 | Assess safety and recognize cardiac arrest; Describe adult CPR and AED use; Describe recovery position and ongoing monitoring |

## Shipped hint (procedural subskill cost, the dearer kind)

| unit | arm | budget | gate estimate | fits | nodes | subskills | cost | node titles |
|---|---|---|---|---|---|---|---|---|
| calc | hint | 90 | 89 | yes | 3 | 6 | 0.0028 | Apply the power rule and basic derivative properties; Differentiate products; Differentiate compositions and combined expressions |
| calc | hint | 90 | 79 | yes | 3 | 5 | 0.0026 | Apply the power rule and basic derivative conventions; Apply the product rule; Apply the chain rule and combine derivative rules |
| resp | hint | 90 | 70 | yes | 3 | 6 | 0.0045 | Track glycolysis and pyruvate oxidation; Track the Krebs cycle; Explain electron transport and connect the stages |
| resp | hint | 90 | 74 | yes | 3 | 6 | 0.0035 | Trace glycolysis; Trace pyruvate oxidation and the Krebs cycle; Explain the electron transport chain and compare stages |
| ww1 | hint | 120 | 95 | yes | 3 | 8 | 0.0035 | Explain long-term pressures in Europe; Trace the crisis from Sarajevo to general war; Build an analytical causes essay |
| ww1 | hint | 120 | 99 | yes | 3 | 8 | 0.0048 | Explain the major long-term tensions; Trace the July Crisis into a European war; Build an evidence-based causal essay |
| esp | hint | 90 | 82 | yes | 3 | 6 | 0.0032 | Recognize the two past-tense forms; Choose a tense for the intended past meaning; Build a past-tense account in text |
| esp | hint | 90 | 86 | yes | 3 | 6 | 0.0031 | Recognize the core contrast; Apply the contrast in context; Compose oral-exam-style responses in text |
| aid | hint | 120 | 96 | yes | 3 | 7 | 0.0049 | Recognize an emergency and activate help; Give adult CPR and use an AED; Place and monitor a person in the recovery position |
| aid | hint | 120 | 110 | yes | 3 | 8 | 0.0056 | Recognize an emergency and initiate help; Describe adult CPR and AED use; Choose and describe the recovery position |

- No hint: 0/10 fit (165–272 min, about 2× budget). Shipped hint: 10/10 fit (70–110 min), 3 nodes each, every unit's objective still covered (titles above). Planner calls also got ~40% cheaper (smaller output).
- Total spend for this experiment: about $0.13.

## Flash (antigravity/gemini-3.8-flash), same hint

| unit | arm | budget | gate estimate | fits | nodes | subskills | cost | node titles |
|---|---|---|---|---|---|---|---|---|
| calc | current | 90 | 135 | no | 5 | 9 | 0.0006 | Power Rule & Linearity (Constant Multiple & Sum/Difference); Product Rule; Quotient Rule (Complementary Shortcut); Chain Rule for Composite Functions; Combined Multi-Rule Problems & Rule Selection Strategy |
| calc | current | 90 | 119 | no | 4 | 9 | 0.0005 | Power Rule and Constant Multiple/Sum Rules; Product Rule; Chain Rule for Composite Functions; Combined Product and Chain Rule Problems |
| calc | hint | 90 | 90 | yes | 3 | 6 | 0.0004 | Power Rule and Basic Linear Combinations; Product Rule; Chain Rule and Combined Rule Selection |
| calc | hint | 90 | 90 | yes | 3 | 6 | 0.0004 | Power Rule and Basic Linear Combinations; Product Rule; Chain Rule and Combined Rules |
| resp | current | 90 | 126 | no | 5 | 10 | 0.0006 | Cellular Respiration Big Picture & Compartmentalization; Glycolysis & Anaerobic Fate (Fermentation); Pyruvate Oxidation & the Citric Acid Cycle; Electron Transport Chain & Oxidative Phosphorylation; ATP Accounting & Disruption by Poisons/Uncouplers |
| resp | current | 90 | 140 | no | 5 | 12 | 0.0006 | Core Energetics and Cellular Geography; Glycolysis and Substrate-Level Phosphorylation; Pyruvate Oxidation and the Citric Acid (Krebs) Cycle; Electron Transport Chain and Chemiosmosis; Whole-Pathway Accounting and Fermentation |
| resp | hint | 90 | 74 | yes | 3 | 6 | 0.0004 | Glycolysis and Pyruvate Oxidation; The Citric Acid (Krebs) Cycle; Oxidative Phosphorylation and ATP Accounting |
| resp | hint | 90 | 74 | yes | 3 | 6 | 0.0004 | Glycolysis and Pyruvate Oxidation; The Krebs (Citric Acid) Cycle; Oxidative Phosphorylation and the Electron Transport Chain |
| ww1 | current | 120 | 126 | no | 5 | 11 | 0.0006 | Long-Term Structural Causes (M-A-I-N); Pre-War Crises and Escalation (1905–1913); The July Crisis and the Outbreak of War (1914); Historiographical Debates on War Guilt; Essay Synthesis: Weighting and Structuring Arguments |
| ww1 | current | 120 | 96 | yes | 4 | 8 | 0.0003 | Long-Term Structural Causes (MAIN); The July Crisis of 1914 & Escalation Cascade; Historiographical Debates on War Guilt & Causation; Essay Synthesis & Thematic Argument Construction |
| ww1 | hint | 120 | 93 | yes | 3 | 8 | 0.0005 | Long-Term Structural Causes (M-A-I-N); The July Crisis and the Mechanism of Escalation; Historiography and Essay Argumentation |
| ww1 | hint | 120 | 81 | yes | 3 | 7 | 0.0004 | Long-Term Structural Causes (MAIN); The July Crisis and the Short-Term Catalyst; Historiographical Synthesis & Essay Argumentation |
| esp | current | 90 | 134 | no | 5 | 10 | 0.0006 | Core Aspect Distinction: Completed Events vs. Ongoing/Habitual Context; Time Markers and Trigger Phrases; Verbs That Shift Meaning by Tense; Foreground vs. Background and Interrupted Actions; Storytelling & Spoken-Response Text Simulation |
| esp | current | 90 | 138 | no | 5 | 10 | 0.0006 | Core aspectual distinction: completed events vs. background states; Temporal trigger words and frequency markers; Verbs that change meaning between preterite and imperfect; Interrupted actions and simultaneous events in storytelling; Oral exam rapid narrative simulation (scripted text practice) |
| esp | hint | 90 | 71 | yes | 3 | 5 | 0.0004 | Aspectual Functions and Temporal Trigger Words; Foreground vs. Background and Interrupted Actions; Oral-Style Prompt Analysis and Justification |
| esp | hint | 90 | 82 | yes | 3 | 6 | 0.0004 | Aspectual Core & Trigger Words; Narrative Interruption & Dual Aspect Sentences; Integrated Oral-Style Storytelling |
| aid | current | 120 | 195 | no | 5 | 16 | 0.0009 | Scene Safety and Primary Assessment; The Recovery Position; High-Quality Adult CPR Mechanics; AED Integration and Operational Safety; Workplace Resuscitation Scenarios and Special Circumstances |
| aid | current | 120 | 177 | no | 5 | 14 | 0.0008 | Scene Safety and Primary Assessment (DRSABCD); The Recovery Position; Adult High-Quality Chest Compressions; Rescue Breaths and Full CPR Cycles (30:2); Automated External Defibrillator (AED) Integration |
| aid | hint | 120 | 100 | yes | 3 | 7 | 0.0004 | Scene Assessment, Responsiveness, and Decision Protocol; Adult CPR Mechanics and Rhythms; Recovery Position Execution and Monitoring |
| aid | hint | 120 | 92 | yes | 3 | 7 | 0.0005 | Scene Assessment, Responsiveness, and Call for Help; Adult CPR Technique and Protocol (30:2); The Recovery Position for Unresponsive Breathing Victims |

- Flash without the hint: 1/10 fit (96–195 min). With it: 10/10 (71–100 min). Cost ≈ $0.01 for all 20 calls.
