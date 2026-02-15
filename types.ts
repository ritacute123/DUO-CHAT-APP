
export interface Message {
  role: 'user' | 'model';
  content: string;
  senderName?: string;
  timestamp: number;
}

export interface Language {
  code: string;
  name: string;
  native: string;
}

export type ProficiencyLevel = 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced';

export interface CanDoExample {
  quote: string;
  translation: string;
}

export interface CannotYetDoExample {
  quote: string;
  correction: string;
}

export interface AssessmentReport {
  overallScore: ProficiencyLevel;
  functionalAbility: string;
  precisionAnalysis: {
    vocabulary: string;
    grammar: string;
    fluency: string;
  };
  contentDepth: string;
  canDo: CanDoExample[];
  cannotYetDo: CannotYetDoExample[];
  summary: string;
  fullSessionTranscript: string;
}

export enum AppState {
  CHATTING = 'CHATTING',
  ASSESSING = 'ASSESSING',
  REPORT = 'REPORT'
}

export interface Persona {
  name: string;
  role: string;
  color: string;
  avatar: string;
}
