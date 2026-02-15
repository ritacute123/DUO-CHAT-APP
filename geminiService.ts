
import { GoogleGenAI, Type, Chat, Modality } from "@google/genai";
import { Message, AssessmentReport } from "./types";

// Always create a new client instance right before use and access API key directly from process.env.API_KEY
export const getGeminiClient = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

const VOCALCOACH_CORE_INSTRUCTION = `
Identity & Role: You are VocalCoach Pro AI, an elite automated language coaching companion.

Elite Adaptive Logic:
1. SESSION START: YOU MUST LEAD. Immediately upon session initialization, introduce yourself and the topic with high energy. Do not wait for user input. Ask a logical, engaging opening question.
2. ADAPTIVE LEVELING:
   - If user output is simple (short sentences, basic grammar), LOWER your level to match. Use simple words and clear phrasing.
   - If user output is sophisticated (complex clauses, idioms), RAISE your level. Use nuanced vocabulary, industry jargon, and advanced metaphors.
3. CONVERSATIONAL FLOW: Never be a passive responder. Drive the dialogue forward logically based on the specific topic selected.
4. SOCIAL INTELLIGENCE: Handle smooth social transitions. If the user is being informal, be a "chatty" peer. If the user is professional, be an "elite consultant".

MODE A: Active Practice (Default)
- Target Language ONLY.
- SCRIPT REQUIREMENT: Use ROMANIZED / LATIN script ONLY for ALL languages. 
  - For Arabic: Use "Arabizi" or standard Latin transliteration.
  - For Chinese: Use Pinyin.
  - For Japanese: Use Romaji.
  - DO NOT output non-Latin characters under any circumstances.
- Turn Dynamics: Concise but extremely proactive.

MODE B: Assessment Mode
- Switch to English only when triggered by assessment keywords.
- Voice Logic: State only "Your report is ready" followed by a brief 1-sentence summary.
`;

export const createDuoChat = (language: string, scenarioName: string, topic?: string) => {
  const ai = getGeminiClient();
  const systemInstruction = `
    ${VOCALCOACH_CORE_INSTRUCTION}
    Current Language: ${language}.
    Scenario Track: ${scenarioName}.
    ${topic ? `Topic Focus: ${topic}.` : ''}
    
    Persona Context:
    - Focus on topic-specific vocabulary and scenarios.
    - Ensure logical progression of ideas.
    - You start the chat now.
  `;

  return ai.chats.create({
    model: 'gemini-3-flash-preview',
    config: {
      systemInstruction,
      temperature: 0.8,
    }
  });
};

export const generateAssessment = async (history: Message[]): Promise<AssessmentReport> => {
  const ai = getGeminiClient();
  const historyText = history.map(m => `${m.role === 'user' ? 'User' : 'VocalCoach'}: ${m.content}`).join('\n');

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: `Perform an elite linguistic and social assessment.
    
    SESSION TAPE:
    ${historyText}
    
    TASKS:
    1. Score level (Novice to Advanced).
    2. Analyze vocabulary, grammar, and social fluency.
    3. Extract "Can-Do" quotes with translations.
    4. Extract "Growth" points with corrections.
    5. Generate a full session transcript in Latin script.
    6. Provide a 1-sentence summary in English.
    `,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          overallScore: { type: Type.STRING },
          functionalAbility: { type: Type.STRING },
          precisionAnalysis: {
            type: Type.OBJECT,
            properties: {
              vocabulary: { type: Type.STRING },
              grammar: { type: Type.STRING },
              fluency: { type: Type.STRING }
            },
            required: ["vocabulary", "grammar", "fluency"]
          },
          contentDepth: { type: Type.STRING },
          canDo: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                quote: { type: Type.STRING },
                translation: { type: Type.STRING }
              }
            }
          },
          cannotYetDo: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                quote: { type: Type.STRING },
                correction: { type: Type.STRING }
              }
            }
          },
          summary: { type: Type.STRING },
          fullSessionTranscript: { type: Type.STRING }
        },
        required: ["overallScore", "functionalAbility", "precisionAnalysis", "summary", "fullSessionTranscript"]
      }
    }
  });

  try {
    return JSON.parse(response.text || '{}');
  } catch (e) {
    throw new Error("Assessment synthesis failed.");
  }
};

export const generateSpeech = async (text: string): Promise<string | undefined> => {
  const ai = getGeminiClient();
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Say this report summary clearly in English: ${text}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });
    return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  } catch (error) {
    return undefined;
  }
};
