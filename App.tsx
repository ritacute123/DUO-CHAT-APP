
import React, { useState, useEffect, useRef } from 'react';
import { Message, Language, AppState, AssessmentReport, Persona, ProficiencyLevel } from './types';
import { LANGUAGES, SCENARIOS, PERSONAS, GENERAL_TOPICS, PUBLIC_SPEAKING_TOPICS, LEADERSHIP_TOPICS } from './constants';
import { createDuoChat, generateAssessment, getGeminiClient, generateSpeech } from './geminiService';
import { Chat, Modality, LiveServerMessage } from '@google/genai';
import { decode, decodeAudioData, createBlob } from './audioUtils';

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState(LANGUAGES[0]);
  const [selectedScenario, setSelectedScenario] = useState(SCENARIOS[0]);
  const [selectedTopic, setSelectedTopic] = useState(GENERAL_TOPICS[0]);
  const [appState, setAppState] = useState<AppState>(AppState.CHATTING);
  const [isLoading, setIsLoading] = useState(false);
  const [report, setReport] = useState<AssessmentReport | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(Date.now());
  const [isSessionActive, setIsSessionActive] = useState(false);
  
  const chatRef = useRef<Chat | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // Live Audio Refs
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const liveSessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionBufferRef = useRef({ user: '', model: '' });

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLive]);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = selectedLanguage.code;
      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
        }
        if (finalTranscript) setInput(prev => prev + (prev.length > 0 && !prev.endsWith(' ') ? ' ' : '') + finalTranscript);
      };
      recognition.onerror = () => setIsRecording(false);
      recognition.onend = () => setIsRecording(false);
      recognitionRef.current = recognition;
    }
  }, [selectedLanguage.code]);

  const toggleRecording = () => {
    if (!recognitionRef.current) return alert("Speech recognition not supported.");
    isRecording ? recognitionRef.current.stop() : recognitionRef.current.start();
    setIsRecording(!isRecording);
  };

  const resetSession = () => {
    stopLiveSession();
    chatRef.current = null;
    setIsSessionActive(false);
    setMessages([]);
    setAppState(AppState.CHATTING);
    setSessionStartTime(null);
    setIsLoading(false);
    setReport(null);
  };

  const startNewChat = async () => {
    stopLiveSession();
    setMessages([]);
    setAppState(AppState.CHATTING);
    setSessionStartTime(Date.now());
    setIsSessionActive(true);
    const focusTopic = selectedTopic;
    chatRef.current = createDuoChat(selectedLanguage.name, selectedScenario.name, focusTopic);
    
    // Bot initiates immediately. isInitial=true hides this system trigger from UI.
    const triggerPrompt = `Introduce yourself and the topic "${focusTopic}" in ${selectedLanguage.name} using ONLY Latin script. Be chatty, social, and ask an opening question to get things started!`;
    handleSendMessage(triggerPrompt, true);
  };

  const handleSendMessage = async (text: string, isInitial = false) => {
    if (!text.trim() && !isInitial) return;
    if (!chatRef.current) return;
    if (isRecording) { recognitionRef.current?.stop(); setIsRecording(false); }

    const triggerKeywords = ['assessment', 'report', 'i need my language assessment now'];
    const isTrigger = !isInitial && triggerKeywords.some(k => text.toLowerCase().includes(k));

    if (!isInitial) {
      if (!sessionStartTime) setSessionStartTime(Date.now());
      const userMsg: Message = { role: 'user', content: text, timestamp: Date.now() };
      setMessages(prev => [...prev, userMsg]);
      setInput('');
      if (isTrigger && canRequestAssessment()) {
        handleTriggerAssessment([...messages, userMsg]);
        return;
      }
    }

    setIsLoading(true);
    try {
      const result = await chatRef.current.sendMessage({ message: text });
      setMessages(prev => [...prev, { role: 'model', content: result.text || "...", timestamp: Date.now() }]);
    } catch (error) {
      console.error("Chat error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const stopLiveSession = () => {
    if (liveSessionRef.current) {
      liveSessionRef.current.then((s: any) => s.close());
      liveSessionRef.current = null;
    }
    audioContextInRef.current?.close();
    audioContextOutRef.current?.close();
    audioContextInRef.current = null;
    audioContextOutRef.current = null;
    setIsLive(false);
  };

  const startLiveSession = async () => {
    if (isLive) { stopLiveSession(); return; }
    if (!sessionStartTime) setSessionStartTime(Date.now());
    setIsSessionActive(true);
    setIsLoading(true);
    setIsLive(true);
    const ai = getGeminiClient();

    audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    nextStartTimeRef.current = 0;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const focusTopic = selectedTopic;

    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      callbacks: {
        onopen: () => {
          const source = audioContextInRef.current!.createMediaStreamSource(stream);
          const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
          scriptProcessor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const pcmBlob = createBlob(inputData);
            sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
          };
          source.connect(scriptProcessor);
          scriptProcessor.connect(audioContextInRef.current!.destination);
          
          // Trigger processing for immediate bot initiation
          sessionPromise.then(s => {
            s.sendRealtimeInput({
               media: { data: "", mimeType: "audio/pcm;rate=16000" }
            });
          });
          
          setIsLoading(false);
        },
        onmessage: async (message: LiveServerMessage) => {
          const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (base64Audio && audioContextOutRef.current) {
            const ctx = audioContextOutRef.current;
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
            const buffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.addEventListener('ended', () => audioSourcesRef.current.delete(source));
            source.start(nextStartTimeRef.current);
            nextStartTimeRef.current += buffer.duration;
            audioSourcesRef.current.add(source);
          }

          if (message.serverContent?.inputTranscription) {
            const text = message.serverContent.inputTranscription.text;
            transcriptionBufferRef.current.user += text;
          }

          if (message.serverContent?.outputTranscription) {
            const text = message.serverContent.outputTranscription.text;
            transcriptionBufferRef.current.model += text;
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'model') {
                return [...prev.slice(0, -1), { ...last, content: transcriptionBufferRef.current.model }];
              } else {
                return [...prev, { role: 'model', content: text, timestamp: Date.now() }];
              }
            });
          }

          if (message.serverContent?.turnComplete) {
            const userText = transcriptionBufferRef.current.user;
            if (userText) {
              setMessages(prev => {
                const lastModel = prev[prev.length - 1];
                const withoutLast = lastModel?.role === 'model' ? prev.slice(0, -1) : prev;
                return [...withoutLast, { role: 'user', content: userText, timestamp: Date.now() }, lastModel].filter(Boolean) as Message[];
              });
            }
            
            const triggerKeywords = ['assessment', 'report', 'i need my language assessment now'];
            if (userText.toLowerCase() && triggerKeywords.some(k => userText.toLowerCase().includes(k)) && canRequestAssessment()) {
              stopLiveSession();
              setMessages(prev => {
                handleTriggerAssessment(prev);
                return prev;
              });
            }
            transcriptionBufferRef.current = { user: '', model: '' };
          }

          if (message.serverContent?.interrupted) {
            audioSourcesRef.current.forEach(s => s.stop());
            audioSourcesRef.current.clear();
            nextStartTimeRef.current = 0;
          }
        },
        onerror: (e) => console.error("Live Error", e),
        onclose: () => setIsLive(false),
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: `VocalCoach Pro Elite Coaching. Topic: ${focusTopic}. Language: ${selectedLanguage.native} (Romanized). YOU MUST START THE CONVERSATION IMMEDIATELY. Greet the user, introduce the topic "${focusTopic}", and ask them an intriguing question to start. Do not wait for them to speak first. Use ONLY Latin script.`,
      },
    });

    liveSessionRef.current = sessionPromise;
  };

  const handleTriggerAssessment = async (history: Message[]) => {
    setAppState(AppState.ASSESSING);
    setIsLoading(true);
    try {
      const assessment = await generateAssessment(history);
      setReport(assessment);
      setAppState(AppState.REPORT);
      
      const readoutText = `Your report is ready. ${assessment.summary}`;
      const base64Audio = await generateSpeech(readoutText);
      if (base64Audio) {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const buffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start();
      }
    } catch (error) {
      console.error("Assessment error:", error);
      setAppState(AppState.CHATTING);
      alert("Assessment synthesis failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const exportReport = () => {
    if (!report) return;
    const content = `VOCALCOACH PRO ASSESSMENT REPORT\n----------------------------------\nProficiency Level: ${report.overallScore}\nFunctional Ability: ${report.functionalAbility}\nSummary: ${report.summary}\n\nFULL SESSION TRANSCRIPT\n-----------------------\n${report.fullSessionTranscript}\n\nDisclaimer: This is an informal characterization.`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VocalCoach_Assessment.txt`;
    a.click();
  };

  const getElapsedTime = () => (!sessionStartTime ? 0 : Math.max(0, currentTime - sessionStartTime));
  const canRequestAssessment = () => getElapsedTime() >= 180000;

  const getAssessmentTimerText = () => {
    if (!sessionStartTime) return "GENERATE MY LANGUAGE ASSESSMENT";
    const remaining = 180000 - getElapsedTime();
    if (remaining <= 0) return "GENERATE MY LANGUAGE ASSESSMENT";
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `LOCKED: ${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const getTopicList = (scenarioId: string) => {
    switch (scenarioId) {
      case 'public': return PUBLIC_SPEAKING_TOPICS;
      case 'leadership': return LEADERSHIP_TOPICS;
      default: return GENERAL_TOPICS;
    }
  };

  const handleScenarioChange = (scenarioId: string) => {
    const sc = SCENARIOS.find(s => s.id === scenarioId);
    if (sc) {
      setSelectedScenario(sc);
      const newList = getTopicList(sc.id);
      setSelectedTopic(newList[0]);
    }
  };

  if (appState === AppState.REPORT && report) {
    return (
      <div className="min-h-screen bg-[#121212] flex flex-col items-center p-4 md:p-8 overflow-y-auto">
        <div className="max-w-4xl w-full bg-[#181818] rounded-2xl shadow-2xl overflow-hidden border border-[#282828] mb-12">
          <div className="bg-gradient-to-br from-[#1DB954] to-[#191414] p-10 text-white flex justify-between items-end">
            <div>
              <h1 className="text-4xl font-black tracking-tighter uppercase">Coach Analysis</h1>
              <p className="mt-2 text-lg opacity-80 italic">"Your report is ready."</p>
            </div>
            <button onClick={exportReport} className="px-6 py-2 bg-white/10 hover:bg-white/20 rounded-full border border-white/20 text-xs font-black uppercase tracking-widest">Export TXT</button>
          </div>
          <div className="p-8 space-y-10">
            <div className="bg-[#282828] p-8 rounded-2xl border border-[#3e3e3e] text-center">
              <p className="text-[10px] font-black text-[#b3b3b3] uppercase tracking-[0.2em] mb-4">Assigned Rank</p>
              <div className="text-6xl font-black text-[#1DB954] tracking-tighter uppercase">{report.overallScore}</div>
            </div>
            <section className="space-y-4">
              <h3 className="text-sm font-black text-[#b3b3b3] uppercase tracking-[0.2em]">Summary</h3>
              <div className="bg-[#282828] p-6 rounded-xl border border-[#3e3e3e] text-white text-lg">{report.summary}</div>
            </section>
            <section className="space-y-4">
              <h3 className="text-sm font-black text-[#b3b3b3] uppercase tracking-[0.2em]">Session Tape</h3>
              <div className="bg-[#121212] p-8 rounded-xl border border-[#282828] max-h-96 overflow-y-auto whitespace-pre-wrap text-sm text-[#b3b3b3] font-mono">{report.fullSessionTranscript}</div>
            </section>
            <button onClick={() => { setAppState(AppState.CHATTING); setSessionStartTime(Date.now()); }} className="w-full py-6 bg-[#1DB954] text-black rounded-full font-black text-2xl hover:scale-[1.02] transition-all">Back to Floor</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#121212] overflow-hidden text-white font-medium">
      <header className="bg-black/95 backdrop-blur-md px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 z-20 sticky top-0 border-b border-[#282828]">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-[#1DB954] flex items-center justify-center font-black text-black">VC</div>
          <div>
            <h1 className="text-2xl font-black tracking-tighter uppercase">VocalCoach <span className="text-[#1DB954]">Pro</span></h1>
            <p className="text-[10px] text-[#535353] font-black tracking-[0.25em] uppercase">{isLive ? "On Air • Adaptive Leveling" : "Ready"}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select value={selectedLanguage.code} onChange={(e) => { const lang = LANGUAGES.find(l => l.code === e.target.value); if (lang) setSelectedLanguage(lang); }} className="bg-[#282828] border-none text-white rounded-full px-4 py-2 text-sm">
            {LANGUAGES.map(lang => <option key={lang.code} value={lang.code}>{lang.native}</option>)}
          </select>
          <select value={selectedScenario.id} onChange={(e) => handleScenarioChange(e.target.value)} className="bg-[#282828] border-none text-white rounded-full px-4 py-2 text-sm">
            {SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)} className="bg-[#1DB954]/10 border border-[#1DB954]/20 text-[#1DB954] rounded-full px-4 py-2 text-sm">
            {getTopicList(selectedScenario.id).map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="flex gap-2">
            <button onClick={startLiveSession} className={`px-6 py-2 rounded-full text-sm font-black transition-all ${isLive ? 'bg-rose-600' : 'bg-white text-black'}`}>{isLive ? 'STOP VOICE' : 'START VOICE'}</button>
            <button onClick={resetSession} className="bg-[#1DB954] text-black px-6 py-2 rounded-full text-sm font-black uppercase tracking-widest">RESET</button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0 relative">
        {!isSessionActive && !isLive ? (
          <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
            <h2 className="text-6xl font-black tracking-tighter text-white mb-6 uppercase">Lead the Conversation.</h2>
            <p className="text-[#b3b3b3] text-2xl max-w-xl mb-12 leading-relaxed">Choose a topic. The coach will introduce it and adapt to your fluency in real-time.</p>
            <div className="flex gap-8">
              <button onClick={startLiveSession} className="px-12 py-6 bg-[#1DB954] text-black rounded-full font-black text-2xl shadow-2xl">Voice Practice</button>
              <button onClick={startNewChat} className="px-12 py-6 bg-white text-black rounded-full font-black text-2xl shadow-2xl">Text Practice</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 md:px-32 py-16 space-y-12" ref={scrollRef}>
            {messages.map((msg, i) => (
              <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[85%] md:max-w-[70%] rounded-2xl p-6 shadow-xl ${msg.role === 'user' ? 'bg-[#1DB954] text-black font-bold' : 'bg-[#282828] text-white border border-[#3e3e3e]'}`}>
                  <p className="whitespace-pre-wrap leading-relaxed text-xl">{msg.content}</p>
                </div>
              </div>
            ))}
            {isLive && (
              <div className="flex justify-center p-12">
                <div className="bg-[#1DB954]/10 border border-[#1DB954]/20 px-10 py-5 rounded-full flex items-center gap-8">
                  <div className="flex gap-2 h-8 items-center">
                    {[1,2,3,4,5,6].map(i => <div key={i} className="w-1 bg-[#1DB954] rounded-full animate-wave" style={{ animationDelay: `${i * 0.1}s` }} />)}
                  </div>
                  <span className="text-[#1DB954] font-black tracking-[0.2em] text-sm uppercase">Elite Audio Session Active</span>
                </div>
              </div>
            )}
            {isLoading && !isLive && (
               <div className="flex justify-start">
                 <div className="bg-[#282828] border border-[#3e3e3e] rounded-2xl p-6 shadow-xl flex space-x-3">
                   <div className="w-2.5 h-2.5 bg-[#1DB954] rounded-full animate-bounce"></div>
                   <div className="w-2.5 h-2.5 bg-[#1DB954] rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                   <div className="w-2.5 h-2.5 bg-[#1DB954] rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                 </div>
               </div>
            )}
          </div>
        )}
      </main>

      {appState === AppState.ASSESSING && (
        <div className="fixed inset-0 bg-black/98 backdrop-blur-3xl flex items-center justify-center z-50">
          <div className="text-center">
            <div className="w-32 h-32 border-[12px] border-[#1DB954] border-t-transparent rounded-full animate-spin mx-auto mb-10"></div>
            <h3 className="text-5xl font-black text-white tracking-tighter uppercase mb-6">Compiling Report...</h3>
            <p className="text-[#b3b3b3] text-2xl">Analyzing linguistic patterns and session transcript.</p>
          </div>
        </div>
      )}

      {(isSessionActive || isLive) && (
        <footer className="bg-black border-t border-[#282828] px-8 py-6 flex flex-col gap-6 shadow-2xl z-30">
          <button onClick={() => handleTriggerAssessment(messages)} disabled={!canRequestAssessment() || isLoading} className={`w-full max-w-2xl mx-auto py-5 rounded-full text-lg font-black uppercase tracking-[0.15em] transition-all shadow-2xl ${canRequestAssessment() ? 'bg-[#1DB954] text-black' : 'bg-[#282828] text-[#535353] opacity-50'}`}>
            {getAssessmentTimerText()}
          </button>
          <div className="max-w-6xl mx-auto w-full flex items-center gap-6">
            <input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleSendMessage(input)} placeholder="Chat with your coach..." className="flex-1 bg-[#282828] border-none text-white rounded-full px-10 py-5 outline-none text-xl" disabled={isLoading || isLive} />
            <button onClick={toggleRecording} disabled={isLive} className={`p-5 rounded-full ${isRecording ? 'bg-rose-600 animate-pulse' : 'bg-[#282828] text-white'}`}>
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-20a3 3 0 00-3 3v10a3 3 0 006 0V3a3 3 0 00-3-3z" /></svg>
            </button>
            {!isLive && <button onClick={() => handleSendMessage(input)} disabled={isLoading || !input.trim()} className="bg-[#1DB954] text-black p-5 rounded-full shadow-2xl"><svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
          </div>
        </footer>
      )}
    </div>
  );
};

export default App;
