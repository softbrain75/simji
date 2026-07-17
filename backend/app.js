const crypto = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

const tableName = process.env.TABLE_NAME;
const bucketName = process.env.BUCKET_NAME;
const sessionSecret = process.env.SESSION_SECRET;
const memberNames = (process.env.MEMBERS || '').split(',').map((name) => name.trim()).filter(Boolean);
const loginSuffix = process.env.LOGIN_SUFFIX || '0717';
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const modelId = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  },
  body: JSON.stringify(body),
});

const toBase64Url = (value) => Buffer.from(value).toString('base64url');
const fromBase64Url = (value) => Buffer.from(value, 'base64url').toString('utf8');
const sign = (value) => crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');

function createSession(member) {
  const payload = toBase64Url(JSON.stringify({ member, exp: Date.now() + 1000 * 60 * 60 * 24 * 180 }));
  return `${payload}.${sign(payload)}`;
}

function getSessionMember(event) {
  const authorization = event.headers?.authorization || event.headers?.Authorization || '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('로그인이 필요합니다.');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('로그인이 만료되었습니다.');
  const session = JSON.parse(fromBase64Url(payload));
  if (!memberNames.includes(session.member) || session.exp < Date.now()) throw new Error('로그인이 만료되었습니다.');
  return session.member;
}

function parseBody(event) {
  if (!event.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return JSON.parse(text);
}

function todayInKorea() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits ? Number(digits) : 0;
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  const matched = text.match(/(20\d{2}|\d{2})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (!matched) return todayInKorea();
  const year = matched[1].length === 2 ? `20${matched[1]}` : matched[1];
  return `${year}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}`;
}

function readModelJson(text) {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('영수증 분석 결과를 읽지 못했습니다.');
  return JSON.parse(json);
}

async function analyzeReceipt(imageBytes) {
  const prompt = `당신은 한국의 카드전표와 영수증을 읽는 장부 도우미입니다. 사진에서 실제 결제 상호, 결제일, 최종 결제 합계를 추출하세요. 공급가액, 부가세, 승인번호가 아니라 고객이 실제로 낸 최종 금액을 amount에 넣으세요. 정보가 확실하지 않으면 null로 표시하세요. 반드시 설명 없이 아래 JSON만 반환하세요.\n{"merchant":"상호 또는 null","date":"YYYY-MM-DD 또는 null","amount":정수 또는 null,"confidence":"high 또는 low"}`;
  const output = await bedrock.send(new ConverseCommand({
    modelId,
    messages: [{ role: 'user', content: [{ image: { format: 'jpeg', source: { bytes: imageBytes } } }, { text: prompt }] }],
    inferenceConfig: { maxTokens: 220, temperature: 0 },
  }));
  const text = output.output.message.content.map((part) => part.text || '').join('');
  const result = readModelJson(text);
  const merchant = typeof result.merchant === 'string' && result.merchant.trim() ? result.merchant.trim().slice(0, 80) : '영수증 확인 필요';
  const amount = normalizeAmount(result.amount);
  const date = normalizeDate(result.date);
  return { merchant, amount, date, needsReview: !amount || result.confidence !== 'high' };
}

async function publicRecord(record) {
  const proofUrl = record.receiptKey
    ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: record.receiptKey }), { expiresIn: 60 * 30 })
    : undefined;
  return { id: record.id, type: record.type, amount: record.amount, date: record.date, memo: record.memo, person: record.person, needsReview: record.needsReview, proofUrl };
}

async function authenticate(event) {
  const { code = '' } = parseBody(event);
  const member = memberNames.find((name) => code.replace(/\s/g, '') === `${name}${loginSuffix}`);
  if (!member) return response(401, { message: '멤버 이름 또는 비밀번호를 확인해 주세요.' });
  return response(200, { member, token: createSession(member) });
}

async function listRecords() {
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': 'SIMJI' },
    ScanIndexForward: false,
    Limit: 150,
  }));
  return Promise.all((result.Items || []).map(publicRecord));
}

async function scanAndSave(event, member) {
  const { imageBase64, mimeType } = parseBody(event);
  if (!imageBase64 || !/^image\//.test(mimeType || '')) return response(400, { message: '영수증 사진이 필요합니다.' });
  const imageBytes = Buffer.from(imageBase64, 'base64');
  if (!imageBytes.length || imageBytes.length > 6 * 1024 * 1024) return response(400, { message: '사진은 6MB 이하로 올려 주세요.' });

  const id = crypto.randomUUID();
  const receiptKey = `receipts/${todayInKorea().slice(0, 7)}/${id}.jpg`;
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: receiptKey, Body: imageBytes, ContentType: 'image/jpeg', ServerSideEncryption: 'AES256' }));

  let analyzed = { merchant: '영수증 확인 필요', amount: 0, date: todayInKorea(), needsReview: true };
  try { analyzed = await analyzeReceipt(imageBytes); }
  catch (error) { console.error('Receipt analysis failed', error.message); }

  const record = {
    pk: 'SIMJI',
    sk: `EXPENSE#${analyzed.date}#${id}`,
    id,
    type: 'expense',
    amount: analyzed.amount,
    date: analyzed.date,
    memo: analyzed.merchant,
    person: member,
    receiptKey,
    needsReview: analyzed.needsReview,
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: record }));
  return response(201, { record: await publicRecord(record), needsReview: record.needsReview });
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.rawPath || event.path;
  if (method === 'OPTIONS') return response(204, {});
  try {
    if (method === 'POST' && path === '/auth') return await authenticate(event);
    const member = getSessionMember(event);
    if (method === 'GET' && path === '/records') return response(200, { records: await listRecords(member) });
    if (method === 'POST' && path === '/expenses/scan') return await scanAndSave(event, member);
    return response(404, { message: '요청한 기능을 찾을 수 없습니다.' });
  } catch (error) {
    console.error(error);
    return response(error.message?.includes('로그인') ? 401 : 500, { message: error.message || '서버 오류가 발생했습니다.' });
  }
};
