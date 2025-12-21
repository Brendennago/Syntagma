require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const DB_PATH = 'syntagma.db';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const initDB = () => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_vocabulary_progress (
            word_id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL, 
            language_code TEXT NOT NULL, 
            word_text TEXT NOT NULL,
            current_step INTEGER DEFAULT 0, 
            srs_interval REAL DEFAULT 0.00069, 
            next_review_date TEXT DEFAULT CURRENT_TIMESTAMP, 
            status TEXT DEFAULT 'learning',
            successful_reads INTEGER DEFAULT 0, 
            lookup_count INTEGER DEFAULT 0,
            is_target_word INTEGER DEFAULT 0,
            target_order INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP, 
            UNIQUE (user_id, language_code, word_text)
        );
        CREATE TABLE IF NOT EXISTS translation_cache (
            word TEXT, 
            source_lang TEXT, 
            target_lang TEXT DEFAULT 'en', 
            translation TEXT,
            PRIMARY KEY (word, source_lang, target_lang)
        );
        CREATE TABLE IF NOT EXISTS reading_sessions (
            session_id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            language_code TEXT NOT NULL,
            passage_text TEXT NOT NULL,
            looked_up_words TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
};
initDB();

const SRS_STEPS = {
    0: { interval: 1, unit: 'minute' }, 1: { interval: 10, unit: 'minute' },
    2: { interval: 60, unit: 'minute' }, 3: { interval: 1, unit: 'day' },
    4: { interval: 3, unit: 'day' }, 5: { interval: 7, unit: 'day' },
    6: { interval: 21, unit: 'day' }, 7: { interval: 90, unit: 'day' },
    8: { interval: 36500, unit: 'day' }
};

const getIntervalInDays = (step) => {
    const srs = SRS_STEPS[step] || SRS_STEPS[8];
    return srs.unit === 'minute' ? srs.interval / 1440 : srs.interval;
};

const getNextReviewDate = (step, fromDate = new Date()) => {
    const srs = SRS_STEPS[step] || SRS_STEPS[8];
    const date = new Date(fromDate);
    if (srs.unit === 'minute') date.setMinutes(date.getMinutes() + srs.interval);
    else date.setDate(date.getDate() + srs.interval);
    return date.toISOString();
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/vocabulary-list', (req, res) => {
    try {
        const { langCode = 'es' } = req.query;
        const rows = db.prepare(`
            SELECT word_text as word, srs_interval as interval, next_review_date as nextReview, 
                   status, current_step as step, is_target_word as isTarget, target_order as targetOrder,
                   (datetime(next_review_date) <= datetime('now')) as isDue 
            FROM user_vocabulary_progress 
            WHERE user_id = ? AND language_code = ? 
            ORDER BY next_review_date ASC
        `).all(MOCK_USER_ID, langCode);
        res.json(rows.map(r => ({ ...r, isDue: r.isDue === 1, isTarget: r.isTarget === 1 })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pass-words-batch', (req, res) => {
    try {
        const { words, langCode = 'es' } = req.body;
        const txTime = new Date();
        db.transaction((list) => {
            for (const word of list) {
                const cleanWord = word.toLowerCase().trim();
                const check = db.prepare(`
                    SELECT current_step, is_target_word, (datetime(next_review_date) <= datetime(?)) as is_due_db 
                    FROM user_vocabulary_progress 
                    WHERE user_id = ? AND language_code = ? AND word_text = ?
                `).get(txTime.toISOString(), MOCK_USER_ID, langCode, cleanWord);
                
                if (!check) {
                    // New word encountered and understood: mark as Mastered (Step 8)
                    const nextStep = 8;
                    db.prepare(`
                        INSERT INTO user_vocabulary_progress 
                        (user_id, language_code, word_text, current_step, srs_interval, next_review_date, status, successful_reads) 
                        VALUES (?, ?, ?, ?, ?, ?, 'learned', 1)
                    `).run(MOCK_USER_ID, langCode, cleanWord, nextStep, getIntervalInDays(nextStep), getNextReviewDate(nextStep, txTime));
                } else if (check.is_due_db === 1 || check.is_target_word === 1) {
                    // If target word is read without lookup, jump to mastered.
                    // Otherwise, proceed to next SRS step.
                    const nextStep = check.is_target_word === 1 ? 8 : Math.min((check.current_step || 0) + 1, 8);
                    
                    db.prepare(`
                        UPDATE user_vocabulary_progress 
                        SET current_step = ?, srs_interval = ?, next_review_date = ?, 
                            status = ?, successful_reads = successful_reads + 1,
                            is_target_word = 0, target_order = NULL
                        WHERE user_id = ? AND language_code = ? AND word_text = ?
                    `).run(nextStep, getIntervalInDays(nextStep), getNextReviewDate(nextStep, txTime), 
                           nextStep >= 6 ? 'learned' : 'learning', MOCK_USER_ID, langCode, cleanWord);
                }
            }
        })(words);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/lookup-word', async (req, res) => {
    const { word, langCode = 'es' } = req.body;
    const clean = word.toLowerCase().trim();
    
    console.log(`🔍 Looking up: ${clean}`);
    const previousState = db.prepare(`
        SELECT current_step as step, srs_interval as interval, next_review_date as nextReview, 
               status, is_target_word as isTarget 
        FROM user_vocabulary_progress WHERE user_id = ? AND language_code = ? AND word_text = ?
    `).get(MOCK_USER_ID, langCode, clean);
    
    // Reset to learning on lookup, remove target status
    db.prepare(`
        INSERT INTO user_vocabulary_progress 
        (user_id, language_code, word_text, current_step, srs_interval, next_review_date, status, lookup_count, is_target_word, target_order) 
        VALUES (?, ?, ?, 0, ?, datetime('now'), 'learning', 1, 0, NULL) 
        ON CONFLICT(user_id, language_code, word_text) DO UPDATE SET 
            current_step = 0, 
            srs_interval = ?, 
            next_review_date = datetime('now'), 
            status = 'learning', 
            lookup_count = lookup_count + 1,
            is_target_word = 0,
            target_order = NULL
    `).run(MOCK_USER_ID, langCode, clean, getIntervalInDays(0), getIntervalInDays(0));
    
    const cached = db.prepare('SELECT translation FROM translation_cache WHERE word = ? AND source_lang = ?').get(clean, langCode);
    if (cached) {
        console.log(`✅ Cache hit: ${cached.translation}`);
        return res.json({ definition: cached.translation, previousState });
    }
    
    try {
        const apiUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=${langCode}|en`;
        const transRes = await axios.get(apiUrl, { timeout: 5000 });
        
        let def = "Translation unavailable.";
        if (transRes.data && transRes.data.responseData && transRes.data.responseData.translatedText) {
            def = transRes.data.responseData.translatedText;
            db.prepare('INSERT OR REPLACE INTO translation_cache (word, source_lang, translation) VALUES (?, ?, ?)').run(clean, langCode, def);
            console.log(`💾 Cached definition for "${clean}": ${def}`);
        }
        return res.json({ definition: def, previousState });
    } catch (e) { 
        console.error("Translation API error:", e.message);
        res.json({ definition: "Translation unavailable.", previousState }); 
    }
});

app.post('/api/undo-lookup', (req, res) => {
    const { word, langCode = 'es', previousState } = req.body;
    const clean = word.toLowerCase().trim();
    
    if (previousState) {
        db.prepare(`
            UPDATE user_vocabulary_progress 
            SET current_step = ?, srs_interval = ?, next_review_date = ?, status = ?, 
                lookup_count = MAX(0, lookup_count - 1), is_target_word = ?, target_order = NULL
            WHERE user_id = ? AND language_code = ? AND word_text = ?
        `).run(previousState.step, previousState.interval, previousState.nextReview, previousState.status, 
               previousState.isTarget ? 1 : 0, MOCK_USER_ID, langCode, clean);
    } else {
        db.prepare('DELETE FROM user_vocabulary_progress WHERE user_id = ? AND language_code = ? AND word_text = ?')
          .run(MOCK_USER_ID, langCode, clean);
    }
    res.json({ success: true });
});

app.post('/api/bulk-action', (req, res) => {
    const { words, action, langCode = 'es' } = req.body;
    db.transaction((list) => {
        for (const word of list) {
            const clean = word.toLowerCase().trim();
            if (action === 'delete') {
                db.prepare('DELETE FROM user_vocabulary_progress WHERE user_id = ? AND language_code = ? AND word_text = ?')
                  .run(MOCK_USER_ID, langCode, clean);
            } else {
                db.prepare(`
                    UPDATE user_vocabulary_progress 
                    SET current_step = 0, srs_interval = ?, next_review_date = datetime('now'), 
                        status = 'learning', is_target_word = 0, target_order = NULL
                    WHERE user_id = ? AND language_code = ? AND word_text = ?
                `).run(getIntervalInDays(0), MOCK_USER_ID, langCode, clean);
            }
        }
    })(words);
    res.json({ success: true });
});

app.post('/api/reset-word', (req, res) => {
    const { word, resetType, langCode = 'es' } = req.body;
    const clean = word.toLowerCase().trim();
    if (resetType === 'delete') {
        db.prepare('DELETE FROM user_vocabulary_progress WHERE user_id = ? AND language_code = ? AND word_text = ?')
          .run(MOCK_USER_ID, langCode, clean);
    } else {
        db.prepare(`
            UPDATE user_vocabulary_progress 
            SET current_step = 0, srs_interval = ?, next_review_date = datetime('now'), 
                status = 'learning', is_target_word = 0, target_order = NULL
            WHERE user_id = ? AND language_code = ? AND word_text = ?
        `).run(getIntervalInDays(0), MOCK_USER_ID, langCode, clean);
    }
    res.json({ success: true });
});

app.post('/api/import-words', (req, res) => {
    try {
        const { words, langCode = 'es', makeTargetList = false, makeDueNow = false } = req.body;
        const maxOrder = db.prepare('SELECT COALESCE(MAX(target_order), -1) as max FROM user_vocabulary_progress WHERE user_id = ? AND language_code = ?').get(MOCK_USER_ID, langCode);
        let currentOrder = maxOrder.max + 1;
        const now = Date.now();
        let calculatedDate;
        
        if (makeDueNow) {
            calculatedDate = new Date(now - 10 * 60 * 1000).toISOString(); // Backdated 10 mins
        } else if (makeTargetList) {
            calculatedDate = new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year future
        } else {
            calculatedDate = new Date(now + 60 * 1000).toISOString(); // 1 minute future
        }

        const stmt = db.prepare(`
            INSERT INTO user_vocabulary_progress 
            (user_id, language_code, word_text, current_step, srs_interval, next_review_date, status, is_target_word, target_order) 
            VALUES (?, ?, ?, 0, ?, ?, 'learning', ?, ?) 
            ON CONFLICT(user_id, language_code, word_text) DO UPDATE SET 
                is_target_word = CASE WHEN ? = 1 THEN 1 ELSE is_target_word END,
                target_order = CASE WHEN ? = 1 AND target_order IS NULL THEN excluded.target_order ELSE target_order END,
                next_review_date = CASE WHEN ? = 1 THEN ? ELSE next_review_date END,
                current_step = CASE WHEN ? = 1 THEN 0 ELSE current_step END,
                status = CASE WHEN ? = 1 THEN 'learning' ELSE status END
        `);
        
        const interval = getIntervalInDays(0);
        db.transaction((list) => {
            list.forEach((w) => {
                const word = w.trim().toLowerCase();
                if (!word) return;
                const targetFlag = makeTargetList ? 1 : 0;
                const isDue = makeDueNow ? 1 : 0;
                const order = makeTargetList ? currentOrder++ : null;
                
                stmt.run(
                    MOCK_USER_ID, langCode, word, interval, calculatedDate, 
                    targetFlag, order,
                    targetFlag, targetFlag, 
                    isDue, calculatedDate, 
                    isDue, isDue
                );
            });
        })(words);
        
        console.log(`✅ Imported ${words.length} words (Target: ${makeTargetList}, DueNow: ${makeDueNow})`);
        res.json({ success: true });
    } catch (err) { 
        console.error("Import error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/save-session', (req, res) => {
    try {
        const { passage, lookedUpWords, langCode = 'es' } = req.body;
        const existing = db.prepare(`
            SELECT session_id FROM reading_sessions 
            WHERE user_id = ? AND language_code = ? 
            ORDER BY updated_at DESC LIMIT 1
        `).get(MOCK_USER_ID, langCode);
        
        if (existing) {
            db.prepare(`
                UPDATE reading_sessions 
                SET passage_text = ?, looked_up_words = ?, updated_at = datetime('now') 
                WHERE session_id = ?
            `).run(passage, JSON.stringify(lookedUpWords), existing.session_id);
        } else {
            db.prepare(`
                INSERT INTO reading_sessions (user_id, language_code, passage_text, looked_up_words) 
                VALUES (?, ?, ?, ?)
            `).run(MOCK_USER_ID, langCode, passage, JSON.stringify(lookedUpWords));
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/load-session', (req, res) => {
    try {
        const { langCode = 'es' } = req.query;
        const session = db.prepare(`
            SELECT passage_text, looked_up_words 
            FROM reading_sessions 
            WHERE user_id = ? AND language_code = ? 
            ORDER BY updated_at DESC LIMIT 1
        `).get(MOCK_USER_ID, langCode);
        
        if (session) {
            res.json({
                passage: session.passage_text,
                lookedUpWords: JSON.parse(session.looked_up_words || '[]')
            });
        } else {
            res.json({ passage: null, lookedUpWords: [] });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/generate-passage', async (req, res) => {
    const { langCode, level } = req.body;
    console.log("📚 Fetching vocabulary for AI generation...");
    const startTime = Date.now();
    
    try {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY not found in .env file");
        }

        const review = db.prepare(`
            SELECT word_text 
            FROM user_vocabulary_progress 
            WHERE user_id = ? AND language_code = ? 
              AND datetime(next_review_date) <= datetime('now') 
            LIMIT 60
        `).all(MOCK_USER_ID, langCode);
        
        const targetLimit = review.length < 30 ? 30 : 15;
        const newWords = db.prepare(`
            SELECT word_text 
            FROM user_vocabulary_progress 
            WHERE user_id = ? AND language_code = ? 
              AND is_target_word = 1 
              AND datetime(next_review_date) > datetime('now')
            ORDER BY target_order ASC 
            LIMIT ?
        `).all(MOCK_USER_ID, langCode, targetLimit);
        
        console.log(`📊 Session: ${review.length} reviews, ${newWords.length} targets.`);
        
        const formulaInstruction = review.length < 60 ? 
            "INTRODUCTION session: Focus on context for NEW_TEST_WORDS. Build strong first impressions." : 
            "REINFORCEMENT session: Prioritize HARD_REVIEW_WORDS to cement long-term memory.";

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        let template = "Generate a story in {LANGUAGE_CODE} at {USER_LEVEL} level.\n{FORMULA_INSTRUCTION}\nInclude these review words: {REVIEW_WORDS_LIST}. Include these new words: {NEW_WORDS_LIST}.\nOutput ONLY JSON: { \"passage\": \"...\", \"glossary\": {} } where glossary ONLY contains NEW_TEST_WORDS definitions.";
        
        try { 
            template = fs.readFileSync('master_prompt.txt', 'utf8'); 
            console.log("✅ Using custom master_prompt.txt");
        } catch (e) {
            console.log("⚠️  Using default prompt");
        }
        
        const prompt = template
            .replace('{LANGUAGE_CODE}', langCode)
            .replace('{USER_LEVEL}', level)
            .replace('{TARGET_STYLE}', 'narrative')
            .replace('{FORMULA_INSTRUCTION}', formulaInstruction)
            .replace('{REVIEW_WORDS_LIST}', review.map(w => w.word_text).join(', ') || 'None')
            .replace('{NEW_WORDS_LIST}', newWords.map(w => w.word_text).join(', ') || 'None');
        
        console.log("🤖 Sending to Gemini 2.5 Flash Lite...");
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: prompt,
            generationConfig: {
                maxOutputTokens: 1200,
                temperature: 0.8,
                topK: 40,
                topP: 0.95,
            }
        });
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ Response in ${elapsed}s`);
        
        const text = response.text;
        let cleanJSON = text.trim().replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        
        let data;
        try {
            data = JSON.parse(cleanJSON);
        } catch (parseError) {
            console.error("❌ JSON Parse Error:", parseError.message);
            throw new Error("AI returned invalid JSON.");
        }
        
        if (!data.passage) {
            throw new Error("AI response missing 'passage' field");
        }
        
        if (data.glossary && typeof data.glossary === 'object') {
            const targetWordSet = new Set(newWords.map(w => w.word_text.toLowerCase()));
            const cacheStmt = db.prepare('INSERT OR REPLACE INTO translation_cache (word, source_lang, translation) VALUES (?, ?, ?)');
            let cached = 0;
            db.transaction(g => {
                Object.entries(g).forEach(([w, d]) => {
                    if (targetWordSet.has(w.toLowerCase())) {
                        cacheStmt.run(w.toLowerCase(), langCode, d);
                        cached++;
                    }
                });
            })(data.glossary);
            console.log(`💾 Cached ${cached} glossary entries (NEW words only)`);
        }
        
        console.log(`✅ Generated in ${elapsed}s!`);
        res.json({ passage: data.passage });
        
    } catch (e) { 
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`❌ Error after ${elapsed}s:`, e.message);
        
        let errorMsg = e.message;
        if (e.message.includes('API_KEY_INVALID')) {
            errorMsg = "Invalid API Key.";
        } else if (e.message.includes('404')) {
            errorMsg = "Model not found. Check API key.";
        } else if (e.message.includes('quota')) {
            errorMsg = "API quota exceeded.";
        }
        
        res.status(500).json({ error: errorMsg }); 
    }
});

console.log("🔧 Database schema verified.");
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Syntagma: http://127.0.0.1:${PORT}`));