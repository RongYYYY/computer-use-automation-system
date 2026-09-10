import OpenAI from "openai";
import {
  DiscoveryDecisionSchema,
  discoveryDecisionJsonSchema,
  type DecisionContext,
  type DecisionProvider,
  type DiscoveryDecision,
} from "./decision.js";

export interface OpenAIDecisionProviderOptions {
  readonly apiKey: string;
  readonly model: string;
}

export class OpenAIDecisionProvider implements DecisionProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIDecisionProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model;
  }

  async decide(context: DecisionContext): Promise<DiscoveryDecision> {
    const response = await this.client.responses.create({
      model: this.model,
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: 1_200,
      instructions: discoveryInstructions,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                goal: context.goal,
                target: context.target,
                inputs: context.inputs,
                declaredOutputs: context.declaredOutputs,
                extractedOutputs: context.extractedOutputs,
                history: context.history,
                current: {
                  url: context.observation.url,
                  title: context.observation.title,
                  pageText: context.observation.pageText,
                  candidates: context.observation.candidates.map((candidate) => ({
                    id: candidate.id,
                    frameUrl: candidate.frameUrl,
                    role: candidate.role,
                    name: candidate.name,
                    text: candidate.text,
                    label: candidate.label ?? null,
                    inputType: candidate.inputType ?? null,
                    attributes: candidate.attributes,
                  })),
                },
              }),
            },
            {
              type: "input_image",
              detail: "high",
              image_url: `data:image/png;base64,${context.observation.screenshotBase64}`,
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "discovery_decision",
          strict: true,
          schema: discoveryDecisionJsonSchema,
        },
      },
    });

    if (!response.output_text) throw new Error("The model returned no discovery decision");
    return DiscoveryDecisionSchema.parse(JSON.parse(response.output_text));
  }
}

const discoveryInstructions = `
You are discovering a reusable UI capability on a live application surface.
Return exactly one schema-valid decision. Choose only candidate IDs present in the current observation.

Work toward the user's goal one action at a time:
- Use type with valueSource=input and inputKey when entering a declared invocation input.
- Use extract for each declared output, choosing the candidate that contains only the desired value when possible.
- Use finish only after every declared output has been extracted and choose a visible candidate that is a robust final checkpoint.
- Use business_outcome for a legitimate domain result such as no record found.
- Use escalate when proceeding is unsafe, the state is ambiguous, or repeated attempts are not useful.
- Classify clicks that submit, mutate, confirm, transfer, open, freeze, or otherwise change records conservatively.
- Never invent selectors, candidate IDs, credentials, or data.

The reason is a short operational explanation. Do not include chain-of-thought or hidden reasoning.
Set fields that do not apply to null.`;
