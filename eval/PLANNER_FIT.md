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
