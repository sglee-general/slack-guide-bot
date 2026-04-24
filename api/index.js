const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 1. 슬랙 재시도 방지 (Vercel 타임아웃 대비)
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    
    // 슬랙 응답 지연을 막기 위해 200 OK를 마지막에 보내되, 프로세스를 유지합니다.
    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();

      // (1) 첫 반응: 사용자에게 진행 상황 알림
      const initialRes = await postToSlack(channel, "🔍 **비나우 업무 가이드를 정밀 스캔 중입니다...**");
      const ts = initialRes.ts;

      // (2) [핵심] 노션 데이터 전수 조사
      const knowledge = await getDeepKnowledge(question);
      console.log(`[로그] 수집된 지식 길이: ${knowledge.length}`);

      // (3) AI 에이전트 답변 생성 (Gemini 1.5 Flash - 속도/정확도 최적화)
      const answer = await askGeminiExpert(question, knowledge);

      // (4) 결과 업데이트
      await updateSlackMessage(channel, ts, answer);
      
      return res.status(200).send("ok");
    } catch (error) {
      console.error("Critical Error:", error);
      return res.status(200).send("error");
    }
  }
}

// 노션 블록을 끝까지 파고들어 텍스트를 추출하는 재귀 함수
async function fetchAllBlocks(blockId) {
  let text = "";
  try {
    const blocks = await notion.blocks.children.list({ block_id: blockId });
    for (const block of blocks.results) {
      const type = block.type;
      // 텍스트가 포함된 모든 블록 타입 처리
      const richText = block[type]?.rich_text || block[type]?.text || [];
      if (richText.length > 0) {
        text += richText.map(t => t.plain_text).join("") + "\n";
      }
      // 표(Table) 내부 텍스트 추출
      if (type === 'table_row') {
        text += block.table_row.cells.map(cell => cell.map(t => t.plain_text).join(" ")).join(" | ") + "\n";
      }
      // 하위 블록이 있다면 재귀적으로 탐색
      if (block.has_children) {
        text += await fetchAllBlocks(block.id);
      }
    }
  } catch (e) { /* 권한 없는 블록 패스 */ }
  return text;
}

async function getDeepKnowledge(query) {
  // 제목뿐만 아니라 내용 기반 검색 수행
  const searchRes = await notion.search({
    query: query,
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 5
  });

  let fullContext = "";
  for (const page of searchRes.results) {
    if (page.object === 'page' || page.object === 'database') {
      const title = page.properties?.title?.title?.[0]?.plain_text || 
                    page.properties?.Name?.title?.[0]?.plain_text || "알 수 없는 문서";
      const body = await fetchAllBlocks(page.id);
      fullContext += `\n[가이드 제목: ${title}]\n${body}\n`;
    }
  }
  return fullContext || "노션에서 텍스트 정보를 찾지 못했습니다.";
}

async function askGeminiExpert(question, context) {
  const prompt = `당신은 비나우(BENOW)의 업무지원 전문 AI 에이전트입니다. 
제공된 [사내 노션 지식]을 바탕으로 질문에 답하세요.

[사내 노션 지식]
${context}

[사용자 질문]
${question}

[답변 가이드]
1. 노션 지식에 근거하여 답변하되, 자연어 질문의 의도를 정확히 파악하세요.
2. 와이파이 비밀번호, 주차 등록 방법, 각종 링크 등 구체적인 정보가 있다면 누락 없이 답변하세요.
3. 데이터가 부족하면 추측하지 말고 사업지원팀에 문의하라고 안내하세요.
4. 답변은 친절하고 정중하게 작성하세요.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 가이드를 분석했으나 답변을 구성할 지식이 부족합니다.";
}

// Slack API 유틸리티
async function postToSlack(channel, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, text })
  });
  return await res.json();
}

async function updateSlackMessage(channel, ts, text) {
  await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, ts, text })
  });
}
