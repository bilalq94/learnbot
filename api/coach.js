export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, mode } = req.body;

  if (!prompt || !mode) {
    return res.status(400).json({ error: 'Missing prompt or mode' });
  }

  const prompts = {
    quiz: `You are a study coach. Based on the following notes/topic, generate a quiz with exactly 5 multiple-choice questions. Each question should have 4 options (A-D) with one correct answer. Format your response as JSON only, no markdown, no backticks: {"questions":[{"q":"question text","options":["A) ...","B) ...","C) ...","D) ..."],"correct":0,"explanation":"brief explanation"}]}. Notes/Topic: ${prompt}`,
    flashcards: `You are a study coach. Based on the following notes/topic, generate exactly 8 flashcards that cover the key concepts. Format your response as JSON only, no markdown, no backticks: {"cards":[{"front":"term or question","back":"definition or answer"}]}. Notes/Topic: ${prompt}`,
    summary: `You are a study coach. Based on the following notes/topic, create a concise study summary with key takeaways. Format your response as JSON only, no markdown, no backticks: {"title":"topic title","sections":[{"heading":"section heading","points":["key point 1","key point 2"]}],"keyTerms":[{"term":"term","definition":"definition"}]}. Notes/Topic: ${prompt}`,
    explain: `You are a study coach. The student is confused about the following topic. Explain it simply using an analogy, then give a concrete example. Format your response as JSON only, no markdown, no backticks: {"topic":"topic name","simpleExplanation":"explanation in simple terms","analogy":"real-world analogy","example":"concrete example","commonMistakes":["mistake 1","mistake 2"]}. Notes/Topic: ${prompt}`
  };

  const systemPrompt = prompts[mode];
  if (!systemPrompt) {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: systemPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(500).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const text = data.content?.map(i => i.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('JSON parse error:', clean.substring(0, 200));
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    return res.status(200).json({ result: parsed });
  } catch (err) {
    console.error('Coach API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
