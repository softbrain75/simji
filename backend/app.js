const crypto = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { GeoPlacesClient, ReverseGeocodeCommand } = require('@aws-sdk/client-geo-places');
const { LocationClient, SearchPlaceIndexForPositionCommand } = require('@aws-sdk/client-location');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const tableName = process.env.TABLE_NAME;
const bucketName = process.env.BUCKET_NAME;
const sessionSecret = process.env.SESSION_SECRET;
const memberNames = (process.env.MEMBERS || '').split(',').map((name) => name.trim()).filter(Boolean);
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const passkeyRpId = process.env.PASSKEY_RP_ID;
const passkeyOrigin = process.env.PASSKEY_ORIGIN;
const memberPinHashes = JSON.parse(Buffer.from(process.env.MEMBER_PIN_HASHES || '', 'base64url').toString('utf8') || '{}');
const modelId = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0';
const treasurerMember = process.env.TREASURER || '성호';
const geoPlacesRegion = process.env.GEO_PLACES_REGION || 'ap-northeast-1';
const photoPlaceIndexName = process.env.PHOTO_PLACE_INDEX_NAME || 'simji-photo-places';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});
const geoPlaces = new GeoPlacesClient({ region: geoPlacesRegion, maxAttempts: 1 });
const location = new LocationClient({ region: geoPlacesRegion, maxAttempts: 1 });

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  },
  body: JSON.stringify(body),
});

const toBase64Url = (value) => Buffer.from(value).toString('base64url');
const fromBase64Url = (value) => Buffer.from(value, 'base64url').toString('utf8');
const sign = (value) => crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');

function createSignedToken(payload) {
  const encoded = toBase64Url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

function createSession(member, authMethod = 'passkey') {
  return createSignedToken({ member, purpose: 'session', authMethod, exp: Date.now() + 1000 * 60 * 60 * 24 * 180 });
}

function readSignedToken(token) {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('로그인이 필요합니다.');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('로그인이 만료되었습니다.');
  const tokenPayload = JSON.parse(fromBase64Url(payload));
  if (!memberNames.includes(tokenPayload.member) || tokenPayload.exp < Date.now()) throw new Error('로그인이 만료되었습니다.');
  return tokenPayload;
}

function getSession(event) {
  const authorization = event.headers?.authorization || event.headers?.Authorization || '';
  const session = readSignedToken(authorization.replace(/^Bearer\s+/i, ''));
  if (session.purpose !== 'session') throw new Error('로그인이 필요합니다.');
  return session;
}

function getSessionMember(event) {
  return getSession(event).member;
}

function getEnrollmentMember(enrollmentToken) {
  const enrollment = readSignedToken(String(enrollmentToken || ''));
  if (enrollment.purpose !== 'passkey-enrollment' || !enrollment.tokenId) throw new Error('기기 등록 확인이 만료되었습니다.');
  return enrollment;
}

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, Buffer.from(salt, 'base64url'), 32).toString('base64url');
}

function verifySetupCode(member, code) {
  const normalized = String(code || '').replace(/\s/g, '');
  const pin = normalized.slice(member.length);
  const stored = memberPinHashes[member];
  if (!normalized.startsWith(member) || !/^\d{4}$/.test(pin) || typeof stored !== 'string') return false;
  const [salt, expectedHash] = stored.split('.');
  if (!salt || !expectedHash) return false;
  const actualHash = hashPin(pin, salt);
  return actualHash.length === expectedHash.length && crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
}

function normalizePersonalPin(value) {
  const pin = String(value || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(pin)) throw new Error('개인 PIN은 숫자 6자리로 정해 주세요.');
  return pin;
}

function createPersonalPinSecret(pin) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return { salt, hash: hashPin(pin, salt) };
}

async function getPersonalPinSecret(member) {
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `AUTH#${member}`, sk: 'LOGIN_PIN' },
  }));
  return result.Item;
}

async function getPinGuard(member, guardKey) {
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `AUTH#${member}`, sk: guardKey },
  }));
  return result.Item;
}

async function recordFailedPin(member, guardKey) {
  const now = Date.now();
  const result = await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: `AUTH#${member}`, sk: guardKey },
    UpdateExpression: 'SET failedAttempts = if_not_exists(failedAttempts, :zero) + :one, lastAttemptAt = :now',
    ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': now },
    ReturnValues: 'ALL_NEW',
  }));
  if (Number(result.Attributes?.failedAttempts || 0) < 20) return false;
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: `AUTH#${member}`, sk: guardKey },
    UpdateExpression: 'SET permanentlyLocked = :locked, lockedAt = :now REMOVE expiresAt',
    ExpressionAttributeValues: {
      ':locked': true,
      ':now': now,
    },
  }));
  return true;
}

async function clearPinGuard(member, guardKey) {
  await ddb.send(new DeleteCommand({
    TableName: tableName,
    Key: { pk: `AUTH#${member}`, sk: guardKey },
  }));
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

function normalizeRefundBank(value) { return String(value || '').trim().slice(0, 20); }
function normalizeRefundAccount(value) { return String(value || '').replace(/\s/g, '').slice(0, 30); }
function isValidRefundAccount(value) { return /^[0-9-]{6,30}$/.test(value); }

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

async function analyzeIncome(imageBytes) {
  const prompt = `당신은 한국 통장 거래내역 화면을 읽는 장부 도우미입니다. 사진에서 실제 입금 거래 한 건의 입금자 이름, 입금일, 입금 금액을 추출하세요. 통장 잔액이나 출금 금액이 아니라 입금으로 표시된 실제 거래 금액만 amount에 넣으세요. 입금자 이름을 알 수 없으면 null로 표시하세요. 반드시 설명 없이 아래 JSON만 반환하세요.\n{"sender":"입금자 이름 또는 null","date":"YYYY-MM-DD 또는 null","amount":정수 또는 null,"confidence":"high 또는 low"}`;
  const output = await bedrock.send(new ConverseCommand({
    modelId,
    messages: [{ role: 'user', content: [{ image: { format: 'jpeg', source: { bytes: imageBytes } } }, { text: prompt }] }],
    inferenceConfig: { maxTokens: 220, temperature: 0 },
  }));
  const text = output.output.message.content.map((part) => part.text || '').join('');
  const result = readModelJson(text);
  const sender = typeof result.sender === 'string' && result.sender.trim() ? result.sender.trim().slice(0, 40) : '입금자 확인 필요';
  const amount = normalizeAmount(result.amount);
  const date = normalizeDate(result.date);
  return { sender, amount, date, needsReview: !amount || result.confidence !== 'high' };
}

async function publicRecord(record) {
  const proofUrl = record.receiptKey
    ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: record.receiptKey }), { expiresIn: 60 * 30 })
    : undefined;
  const paymentStatus = record.type === 'expense' && ['paid', 'pending'].includes(record.paymentStatus) ? record.paymentStatus : record.type === 'expense' ? 'unconfirmed' : undefined;
  return { id: record.id, type: record.type, amount: record.amount, date: record.date, memo: record.memo, person: record.person, refundBank: record.refundBank, refundAccount: record.refundAccount, paymentStatus, paymentDate: record.paymentDate, paymentCompletedAt: record.paymentCompletedAt, paymentCompletedBy: record.paymentCompletedBy, needsReview: record.needsReview, proofUrl };
}

async function authenticate(event) {
  const { member: requestedMember = '', password = '' } = parseBody(event);
  const member = String(requestedMember).trim();
  if (!member) return response(401, { message: '멤버 이름 또는 4자리 번호를 확인해 주세요.' });
  const guard = await getPinGuard(member, 'SETUP_GUARD');
  if (guard?.permanentlyLocked) return response(423, { message: '20회 연속 실패로 잠겼습니다. 개발자에게 초기화를 요청해 주세요.' });
  if (!memberNames.includes(member) || !verifySetupCode(member, `${member}${String(password).replace(/\s/g, '')}`)) {
    await recordFailedPin(member, 'SETUP_GUARD');
    return response(401, { message: '멤버 이름 또는 4자리 번호를 확인해 주세요.' });
  }
  await clearPinGuard(member, 'SETUP_GUARD');

  const existing = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `AUTH#${member}`, ':prefix': 'PASSKEY#' },
    Limit: 1,
  }));
  if ((existing.Items || []).length) return response(403, { message: '이 멤버는 이미 기기 등록을 마쳤습니다. 지문·얼굴 인증으로 로그인해 주세요.' });

  const tokenId = crypto.randomUUID();
  return response(200, {
    member,
    enrollmentToken: createSignedToken({
      member,
      purpose: 'passkey-enrollment',
      tokenId,
      exp: Date.now() + 1000 * 60 * 5,
    }),
  });
}

async function authenticateWithPersonalPin(event) {
  const { member = '', pin = '' } = parseBody(event);
  if (!memberNames.includes(member)) return response(401, { message: '이름 또는 개인 PIN을 확인해 주세요.' });
  const guard = await getPinGuard(member, 'LOGIN_PIN_GUARD');
  if (guard?.permanentlyLocked) return response(423, { message: '20회 연속 실패로 잠겼습니다. 개발자에게 초기화를 요청해 주세요.' });

  const secret = await getPersonalPinSecret(member);
  const normalizedPin = String(pin || '').replace(/\D/g, '');
  const isValid = secret && /^\d{6}$/.test(normalizedPin)
    && hashPin(normalizedPin, secret.salt).length === secret.hash.length
    && crypto.timingSafeEqual(Buffer.from(hashPin(normalizedPin, secret.salt)), Buffer.from(secret.hash));
  if (!isValid) {
    await recordFailedPin(member, 'LOGIN_PIN_GUARD');
    return response(401, { message: '이름 또는 개인 PIN을 확인해 주세요.' });
  }
  await clearPinGuard(member, 'LOGIN_PIN_GUARD');
  return response(200, { member, token: createSession(member, 'pin') });
}

async function setPersonalPin(event) {
  const session = getSession(event);
  if (session.authMethod !== 'passkey') return response(403, { message: '개인 PIN 설정은 지문·얼굴 인증 후에만 할 수 있어요.' });
  const { pin } = parseBody(event);
  const secret = createPersonalPinSecret(normalizePersonalPin(pin));
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: { pk: `AUTH#${session.member}`, sk: 'LOGIN_PIN', ...secret, updatedAt: new Date().toISOString() },
  }));
  return response(200, { configured: true });
}

async function listPasskeys(member) {
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `AUTH#${member}`, ':prefix': 'PASSKEY#' },
  }));
  return result.Items || [];
}

async function createPasskeyRegistrationOptions(event) {
  const { enrollmentToken, pin } = parseBody(event);
  const enrollment = getEnrollmentMember(enrollmentToken);
  const personalPin = normalizePersonalPin(pin);
  const existing = await listPasskeys(enrollment.member);
  if (existing.length) return response(403, { message: '이미 기기 등록을 마쳤습니다. 지문·얼굴 인증으로 로그인해 주세요.' });

  const options = await generateRegistrationOptions({
    rpName: '심지회',
    rpID: passkeyRpId,
    userName: enrollment.member,
    userDisplayName: `${enrollment.member} · 심지회`,
    userID: Buffer.from(`simji:${enrollment.member}`, 'utf8'),
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-7, -257],
  });

  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AUTH#${enrollment.member}`,
      sk: `CHALLENGE#REGISTRATION#${enrollment.tokenId}`,
      challenge: options.challenge,
      personalPin: createPersonalPinSecret(personalPin),
      expiresAt: Date.now() + 1000 * 60 * 5,
      createdAt: new Date().toISOString(),
    },
  }));
  return response(200, { options });
}

async function verifyPasskeyRegistration(event) {
  const { enrollmentToken, credential } = parseBody(event);
  const enrollment = getEnrollmentMember(enrollmentToken);
  const challengeKey = { pk: `AUTH#${enrollment.member}`, sk: `CHALLENGE#REGISTRATION#${enrollment.tokenId}` };
  const stored = await ddb.send(new GetCommand({ TableName: tableName, Key: challengeKey }));
  if (!stored.Item || stored.Item.expiresAt < Date.now()) throw new Error('기기 등록 시간이 만료되었습니다. 처음부터 다시 시도해 주세요.');

  const verification = await verifyRegistrationResponse({
    response: credential,
    expectedChallenge: stored.Item.challenge,
    expectedOrigin: passkeyOrigin,
    expectedRPID: passkeyRpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257],
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error('기기 등록을 확인하지 못했습니다. 다시 시도해 주세요.');

  const { credential: verifiedCredential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const credentialId = verifiedCredential.id;
  const now = new Date().toISOString();
  if (!stored.Item.personalPin?.salt || !stored.Item.personalPin?.hash) throw new Error('개인 PIN 설정을 확인하지 못했습니다. 처음부터 다시 시도해 주세요.');
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `AUTH#${enrollment.member}`,
            sk: `PASSKEY#${credentialId}`,
            credentialId,
            publicKey: Buffer.from(verifiedCredential.publicKey).toString('base64url'),
            counter: verifiedCredential.counter,
            transports: credential.response?.transports || [],
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            createdAt: now,
          },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: { pk: 'AUTH#INDEX', sk: `CREDENTIAL#${credentialId}`, member: enrollment.member, createdAt: now },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `AUTH#${enrollment.member}`,
            sk: 'LOGIN_PIN',
            salt: stored.Item.personalPin.salt,
            hash: stored.Item.personalPin.hash,
            updatedAt: now,
          },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      { Delete: { TableName: tableName, Key: challengeKey } },
    ],
  }));

  return response(200, { member: enrollment.member, token: createSession(enrollment.member) });
}

async function createAdditionalPasskeyRegistrationOptions(event) {
  const session = getSession(event);
  const existing = await listPasskeys(session.member);
  const options = await generateRegistrationOptions({
    rpName: '심지회',
    rpID: passkeyRpId,
    userName: session.member,
    userDisplayName: `${session.member} · 심지회`,
    userID: Buffer.from(`simji:${session.member}`, 'utf8'),
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: existing.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports || [],
    })),
  });
  const requestId = crypto.randomUUID();
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AUTH#${session.member}`,
      sk: `CHALLENGE#ADDITIONAL#${requestId}`,
      challenge: options.challenge,
      expiresAt: Date.now() + 1000 * 60 * 5,
      createdAt: new Date().toISOString(),
    },
  }));
  return response(200, { requestId, options });
}

async function verifyAdditionalPasskeyRegistration(event) {
  const session = getSession(event);
  const { requestId, credential } = parseBody(event);
  if (!requestId || !credential?.id) throw new Error('인증 정보를 확인하지 못했습니다. 다시 시도해 주세요.');
  const challengeKey = { pk: `AUTH#${session.member}`, sk: `CHALLENGE#ADDITIONAL#${requestId}` };
  const stored = await ddb.send(new GetCommand({ TableName: tableName, Key: challengeKey }));
  if (!stored.Item || stored.Item.expiresAt < Date.now()) throw new Error('기기 등록 시간이 만료되었습니다. PIN 로그인 후 다시 시도해 주세요.');

  const verification = await verifyRegistrationResponse({
    response: credential,
    expectedChallenge: stored.Item.challenge,
    expectedOrigin: passkeyOrigin,
    expectedRPID: passkeyRpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257],
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error('기기 등록을 확인하지 못했습니다. 다시 시도해 주세요.');

  const { credential: verifiedCredential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const credentialId = verifiedCredential.id;
  const now = new Date().toISOString();
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `AUTH#${session.member}`,
            sk: `PASSKEY#${credentialId}`,
            credentialId,
            publicKey: Buffer.from(verifiedCredential.publicKey).toString('base64url'),
            counter: verifiedCredential.counter,
            transports: credential.response?.transports || [],
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            createdAt: now,
          },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: { pk: 'AUTH#INDEX', sk: `CREDENTIAL#${credentialId}`, member: session.member, createdAt: now },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      { Delete: { TableName: tableName, Key: challengeKey } },
    ],
  }));
  return response(200, { registered: true });
}

async function createPasskeyAuthenticationOptions(event) {
  const { member: requestedMember = '' } = parseBody(event);
  const member = String(requestedMember).trim();
  const knownMember = memberNames.includes(member) ? member : '';
  const passkeys = knownMember ? await listPasskeys(knownMember) : [];
  const options = await generateAuthenticationOptions({
    rpID: passkeyRpId,
    allowCredentials: passkeys.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports || [],
    })),
    userVerification: 'required',
  });
  const requestId = crypto.randomUUID();
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: 'AUTH#CHALLENGE',
      sk: `LOGIN#${requestId}`,
      challenge: options.challenge,
      ...(knownMember ? { member: knownMember } : {}),
      expiresAt: Date.now() + 1000 * 60 * 5,
      createdAt: new Date().toISOString(),
    },
  }));
  return response(200, { requestId, options, hasPasskey: passkeys.length > 0 });
}

async function verifyPasskeyAuthentication(event) {
  const { requestId, credential } = parseBody(event);
  if (!requestId || !credential?.id) throw new Error('인증 정보를 확인하지 못했습니다. 다시 시도해 주세요.');
  const challengeKey = { pk: 'AUTH#CHALLENGE', sk: `LOGIN#${requestId}` };
  const challenge = await ddb.send(new GetCommand({ TableName: tableName, Key: challengeKey }));
  if (!challenge.Item || challenge.Item.expiresAt < Date.now()) throw new Error('인증 시간이 만료되었습니다. 다시 시도해 주세요.');

  const index = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { pk: 'AUTH#INDEX', sk: `CREDENTIAL#${credential.id}` },
  }));
  const member = index.Item?.member;
  if (!memberNames.includes(member)) throw new Error('등록되지 않은 기기입니다.');
  if (challenge.Item.member && challenge.Item.member !== member) {
    throw new Error('이 기기에 등록된 멤버의 인증키만 사용할 수 있어요.');
  }
  const storedPasskey = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `AUTH#${member}`, sk: `PASSKEY#${credential.id}` },
  }));
  if (!storedPasskey.Item) throw new Error('등록되지 않은 기기입니다.');

  const verification = await verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: challenge.Item.challenge,
    expectedOrigin: passkeyOrigin,
    expectedRPID: passkeyRpId,
    credential: {
      id: storedPasskey.Item.credentialId,
      publicKey: Buffer.from(storedPasskey.Item.publicKey, 'base64url'),
      counter: Number(storedPasskey.Item.counter || 0),
      transports: storedPasskey.Item.transports || [],
    },
    requireUserVerification: true,
  });
  if (!verification.verified) throw new Error('지문·얼굴 인증을 확인하지 못했습니다. 다시 시도해 주세요.');

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tableName,
          Key: { pk: `AUTH#${member}`, sk: `PASSKEY#${credential.id}` },
          UpdateExpression: 'SET #counter = :counter, #lastUsedAt = :lastUsedAt',
          ExpressionAttributeNames: { '#counter': 'counter', '#lastUsedAt': 'lastUsedAt' },
          ExpressionAttributeValues: { ':counter': verification.authenticationInfo.newCounter, ':lastUsedAt': new Date().toISOString() },
        },
      },
      { Delete: { TableName: tableName, Key: challengeKey } },
    ],
  }));
  const personalPin = await getPersonalPinSecret(member);
  return response(200, { member, token: createSession(member, 'passkey'), needsPinSetup: !personalPin });
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

function encodeCursor(key) {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : undefined;
}

function decodeCursor(cursor) {
  if (!cursor) return undefined;
  try {
    const key = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (key?.pk === 'SIMJI_MEDIA' && typeof key.sk === 'string') return key;
  } catch {
    // An invalid cursor is handled as the first page.
  }
  return undefined;
}

function normalizeCaption(value) {
  return String(value || '').trim().slice(0, 80);
}

function normalizeCapturedAt(value, fallbackDate) {
  const matched = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!matched || !isValidDate(matched[1])) return '';
  const [, date, hour, minute, second] = matched;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return '';
  return `${date === fallbackDate ? date : fallbackDate}T${hour}:${minute}:${second}`;
}

function normalizeCoordinate(value, min, max) {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= min && coordinate <= max ? coordinate : undefined;
}

function addressPart(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value.Name === 'string') return value.Name.trim();
  return '';
}

function compactLocation(values, fallback = '') {
  const parts = values.map(addressPart).filter(Boolean);
  const unique = parts.filter((value, index) => !parts.slice(0, index).some((existing) => existing === value));
  return (unique.join(' · ') || fallback).slice(0, 120);
}

async function findPhotoRegion(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  try {
    const result = await location.send(new SearchPlaceIndexForPositionCommand({
      IndexName: photoPlaceIndexName,
      Position: [longitude, latitude],
      MaxResults: 1,
      Language: 'ko',
    }));
    const place = result.Results?.[0]?.Place || {};
    const region = compactLocation([place.Region, place.Municipality, place.SubMunicipality], String(place.Label || '').trim());
    if (region) return region;
  } catch (error) {
    console.warn('Unable to resolve photo region with place index', error.name || 'UnknownError');
  }
  try {
    const result = await geoPlaces.send(new ReverseGeocodeCommand({
      QueryPosition: [longitude, latitude],
      MaxResults: 1,
      Language: 'ko',
      IntendedUse: 'Storage',
    }));
    const item = result.ResultItems?.[0] || {};
    const address = item.Address || {};
    return compactLocation([
      addressPart(address.Region),
      addressPart(address.SubRegion),
      addressPart(address.Locality),
      addressPart(address.District),
      addressPart(address.Neighborhood),
    ], String(item.Title || '').trim());
  } catch (error) {
    console.warn('Unable to resolve photo region', error.name || 'UnknownError');
    return '';
  }
}

function extractYouTubeId(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
      else id = url.pathname.split('/').filter(Boolean)[1] || '';
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

function decodeImage(value, maxBytes) {
  const source = String(value || '');
  if (!source || !/^[A-Za-z0-9+/=]+$/.test(source)) return null;
  const image = Buffer.from(source, 'base64');
  return image.length && image.length <= maxBytes ? image : null;
}

async function publicMediaItem(record, { includeOriginal = false } = {}) {
  const thumbnailUrl = record.mediaType === 'photo'
    ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: record.thumbnailKey }), { expiresIn: 60 * 30 })
    : `https://i.ytimg.com/vi/${record.youtubeId}/hqdefault.jpg`;
  const photoUrl = includeOriginal && record.mediaType === 'photo'
    ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: record.photoKey }), { expiresIn: 60 * 30 })
    : undefined;
  return {
    id: record.id,
    mediaType: record.mediaType,
    date: record.date,
    capturedAt: record.capturedAt,
    locationName: record.locationName,
    caption: record.caption,
    person: record.person,
    thumbnailUrl,
    photoUrl,
    youtubeUrl: record.youtubeId ? `https://www.youtube.com/watch?v=${record.youtubeId}` : undefined,
    createdAt: record.createdAt,
  };
}

async function listMedia(event) {
  const query = event.queryStringParameters || {};
  const rawLimit = Number(query.limit || 18);
  const requestedLimit = Number.isFinite(rawLimit) ? rawLimit : 18;
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': 'SIMJI_MEDIA' },
    ScanIndexForward: false,
    Limit: Math.min(Math.max(requestedLimit, 1), 24),
    ExclusiveStartKey: decodeCursor(query.cursor),
  }));
  return {
    items: await Promise.all((result.Items || []).map((item) => publicMediaItem(item))),
    nextCursor: encodeCursor(result.LastEvaluatedKey),
  };
}

async function findMedia(id) {
  let startKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'SIMJI_MEDIA' },
      ExclusiveStartKey: startKey,
    }));
    const record = (result.Items || []).find((item) => item.id === id);
    if (record) return record;
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return null;
}

async function getMedia(event) {
  const id = event.pathParameters?.id;
  if (!id) return response(404, { message: '사진 또는 영상을 찾을 수 없습니다.' });
  const record = await findMedia(id);
  if (!record) return response(404, { message: '사진 또는 영상을 찾을 수 없습니다.' });
  return response(200, { item: await publicMediaItem(record, { includeOriginal: true }) });
}

async function savePhoto(event, member) {
  const { imageBase64, thumbnailBase64, date = todayInKorea(), capturedAt = '', latitude, longitude, caption = '' } = parseBody(event);
  if (!isValidDate(date)) return response(400, { message: '사진 날짜를 확인해 주세요.' });
  const image = decodeImage(imageBase64, 4 * 1024 * 1024);
  const thumbnail = decodeImage(thumbnailBase64, 1024 * 1024);
  if (!image || !thumbnail) return response(400, { message: '사진을 읽지 못했어요. 다시 선택해 주세요.' });
  const normalizedLatitude = normalizeCoordinate(latitude, -90, 90);
  const normalizedLongitude = normalizeCoordinate(longitude, -180, 180);
  const locationName = await findPhotoRegion(normalizedLatitude, normalizedLongitude);

  const id = crypto.randomUUID();
  const prefix = `media/${date.slice(0, 7)}/${id}`;
  const photoKey = `${prefix}.jpg`;
  const thumbnailKey = `${prefix}-thumb.jpg`;
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: bucketName, Key: photoKey, Body: image, ContentType: 'image/jpeg', ServerSideEncryption: 'AES256' })),
    s3.send(new PutObjectCommand({ Bucket: bucketName, Key: thumbnailKey, Body: thumbnail, ContentType: 'image/jpeg', ServerSideEncryption: 'AES256' })),
  ]);
  const record = {
    pk: 'SIMJI_MEDIA',
    sk: `MEDIA#${date}#${id}`,
    id,
    mediaType: 'photo',
    date,
    capturedAt: normalizeCapturedAt(capturedAt, date),
    locationName,
    caption: normalizeCaption(caption),
    person: member,
    photoKey,
    thumbnailKey,
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: record }));
  return response(201, { item: await publicMediaItem(record) });
}

async function saveVideo(event, member) {
  const { url, date = todayInKorea(), caption = '' } = parseBody(event);
  if (!isValidDate(date)) return response(400, { message: '영상 날짜를 확인해 주세요.' });
  const youtubeId = extractYouTubeId(url);
  if (!youtubeId) return response(400, { message: '유효한 유튜브 영상 또는 Shorts 링크를 넣어 주세요.' });
  const id = crypto.randomUUID();
  const record = {
    pk: 'SIMJI_MEDIA',
    sk: `MEDIA#${date}#${id}`,
    id,
    mediaType: 'video',
    date,
    caption: normalizeCaption(caption),
    person: member,
    youtubeId,
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: record }));
  return response(201, { item: await publicMediaItem(record) });
}

async function updateMedia(event, member) {
  const id = event.pathParameters?.id;
  const record = id && await findMedia(id);
  if (!record) return response(404, { message: '사진 또는 영상을 찾을 수 없습니다.' });
  if (record.person !== member) return response(403, { message: '등록한 멤버만 수정할 수 있습니다.' });
  const { date, caption = '' } = parseBody(event);
  if (!isValidDate(date)) return response(400, { message: '날짜를 확인해 주세요.' });
  const updatedAt = new Date().toISOString();
  const updated = { ...record, date, caption: normalizeCaption(caption), updatedAt, updatedBy: member };

  if (date === record.date) {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: record.pk, sk: record.sk },
      UpdateExpression: 'SET #caption = :caption, updatedAt = :updatedAt, updatedBy = :updatedBy',
      ExpressionAttributeNames: { '#caption': 'caption' },
      ExpressionAttributeValues: { ':caption': updated.caption, ':updatedAt': updatedAt, ':updatedBy': member },
      ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
    }));
  } else {
    updated.sk = `MEDIA#${date}#${record.id}`;
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: updated, ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' } },
        { Delete: { TableName: tableName, Key: { pk: record.pk, sk: record.sk }, ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)' } },
      ],
    }));
  }
  return response(200, { item: await publicMediaItem(updated) });
}

async function deleteMedia(event, member) {
  const id = event.pathParameters?.id;
  const record = id && await findMedia(id);
  if (!record) return response(404, { message: '사진 또는 영상을 찾을 수 없습니다.' });
  if (record.person !== member) return response(403, { message: '등록한 멤버만 삭제할 수 있습니다.' });
  await ddb.send(new DeleteCommand({
    TableName: tableName,
    Key: { pk: record.pk, sk: record.sk },
    ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
  }));
  if (record.mediaType === 'photo') {
    await Promise.all([record.photoKey, record.thumbnailKey].filter(Boolean).map((Key) => (
      s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key })).catch((error) => console.error('Media cleanup failed', error.message))
    )));
  }
  return response(200, { deleted: true });
}

async function scanAndSave(event, member) {
  const { imageBase64, mimeType, refundBank: rawRefundBank, refundAccount: rawRefundAccount } = parseBody(event);
  if (!imageBase64 || !/^image\//.test(mimeType || '')) return response(400, { message: '영수증 사진이 필요합니다.' });
  const imageBytes = Buffer.from(imageBase64, 'base64');
  if (!imageBytes.length || imageBytes.length > 6 * 1024 * 1024) return response(400, { message: '사진은 6MB 이하로 올려 주세요.' });

  const refundBank = normalizeRefundBank(rawRefundBank);
  const refundAccount = normalizeRefundAccount(rawRefundAccount);
  if (!refundBank || !isValidRefundAccount(refundAccount)) return response(400, { message: '환불 받을 은행명과 계좌번호를 확인해 주세요.' });

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
    refundBank,
    refundAccount,
    paymentStatus: 'pending',
    receiptKey,
    needsReview: analyzed.needsReview,
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: record }));
  return response(201, { record: await publicRecord(record), needsReview: record.needsReview });
}

async function scanIncomeAndSave(event) {
  const { imageBase64, mimeType } = parseBody(event);
  if (!imageBase64 || !/^image\//.test(mimeType || '')) return response(400, { message: '입금 내역 사진이 필요합니다.' });
  const imageBytes = Buffer.from(imageBase64, 'base64');
  if (!imageBytes.length || imageBytes.length > 6 * 1024 * 1024) return response(400, { message: '사진은 6MB 이하로 올려 주세요.' });

  const id = crypto.randomUUID();
  const receiptKey = `incomes/${todayInKorea().slice(0, 7)}/${id}.jpg`;
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: receiptKey, Body: imageBytes, ContentType: 'image/jpeg', ServerSideEncryption: 'AES256' }));

  let analyzed = { sender: '입금자 확인 필요', amount: 0, date: todayInKorea(), needsReview: true };
  try { analyzed = await analyzeIncome(imageBytes); }
  catch (error) { console.error('Income analysis failed', error.message); }

  const record = {
    pk: 'SIMJI',
    sk: `INCOME#${analyzed.date}#${id}`,
    id,
    type: 'income',
    amount: analyzed.amount,
    date: analyzed.date,
    memo: '회비 입금',
    person: analyzed.sender,
    receiptKey,
    needsReview: analyzed.needsReview,
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: record }));
  return response(201, { record: await publicRecord(record), needsReview: record.needsReview });
}

function isValidDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

async function findExpense(id) {
  let startKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'SIMJI' },
      ExclusiveStartKey: startKey,
    }));
    const record = (result.Items || []).find((item) => item.id === id && item.type === 'expense');
    if (record) return record;
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return null;
}

async function updateExpense(event, member) {
  const id = event.pathParameters?.id;
  if (!id) return response(404, { message: '지출 기록을 찾을 수 없습니다.' });

  const record = await findExpense(id);
  if (!record) return response(404, { message: '지출 기록을 찾을 수 없습니다.' });
  if (record.person !== member) return response(403, { message: '지출을 등록한 멤버만 수정할 수 있습니다.' });

  const { amount: rawAmount, date, memo = '', refundBank: rawRefundBank, refundAccount: rawRefundAccount } = parseBody(event);
  const amount = normalizeAmount(rawAmount);
  if (!amount || amount > 100000000) return response(400, { message: '금액을 확인해 주세요.' });
  if (!isValidDate(date)) return response(400, { message: '날짜를 확인해 주세요.' });

  const refundBank = rawRefundBank === undefined ? (record.refundBank || '') : normalizeRefundBank(rawRefundBank);
  const refundAccount = rawRefundAccount === undefined ? (record.refundAccount || '') : normalizeRefundAccount(rawRefundAccount);
  if ((refundBank || refundAccount) && (!refundBank || !isValidRefundAccount(refundAccount))) return response(400, { message: '환불 받을 은행명과 계좌번호를 확인해 주세요.' });

  const updatedRecord = {
    ...record,
    amount,
    date,
    memo: String(memo).trim().slice(0, 80),
    refundBank,
    refundAccount,
    needsReview: false,
    updatedAt: new Date().toISOString(),
    updatedBy: member,
  };
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: record.pk, sk: record.sk },
    UpdateExpression: 'SET #amount = :amount, #date = :date, #memo = :memo, #refundBank = :refundBank, #refundAccount = :refundAccount, #needsReview = :needsReview, updatedAt = :updatedAt, updatedBy = :updatedBy',
    ExpressionAttributeNames: {
      '#amount': 'amount',
      '#date': 'date',
      '#memo': 'memo',
      '#refundBank': 'refundBank',
      '#refundAccount': 'refundAccount',
      '#needsReview': 'needsReview',
    },
    ExpressionAttributeValues: {
      ':amount': updatedRecord.amount,
      ':date': updatedRecord.date,
      ':memo': updatedRecord.memo,
      ':refundBank': updatedRecord.refundBank,
      ':refundAccount': updatedRecord.refundAccount,
      ':needsReview': updatedRecord.needsReview,
      ':updatedAt': updatedRecord.updatedAt,
      ':updatedBy': updatedRecord.updatedBy,
    },
    ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
  }));
  return response(200, { record: await publicRecord(updatedRecord) });
}

async function updatePaymentStatus(event, member) {
  if (member !== treasurerMember) return response(403, { message: '통장 담당자만 입금 상태를 처리할 수 있습니다.' });

  const id = event.pathParameters?.id;
  if (!id) return response(404, { message: '지출 기록을 찾을 수 없습니다.' });
  const record = await findExpense(id);
  if (!record) return response(404, { message: '지출 기록을 찾을 수 없습니다.' });

  const { status: rawStatus, paymentDate: rawPaymentDate } = parseBody(event);
  const status = String(rawStatus || '').trim();
  if (!['paid', 'pending'].includes(status)) return response(400, { message: '입금 상태를 확인해 주세요.' });

  const isPaid = status === 'paid';
  const paymentDate = isPaid ? String(rawPaymentDate || todayInKorea()) : undefined;
  if (isPaid && !isValidDate(paymentDate)) return response(400, { message: '입금일을 확인해 주세요.' });
  const updatedAt = new Date().toISOString();
  const updatedRecord = {
    ...record,
    paymentStatus: status,
    updatedAt,
    updatedBy: member,
  };
  if (isPaid) {
    updatedRecord.paymentDate = paymentDate;
    updatedRecord.paymentCompletedAt = updatedAt;
    updatedRecord.paymentCompletedBy = member;
  } else {
    delete updatedRecord.paymentDate;
    delete updatedRecord.paymentCompletedAt;
    delete updatedRecord.paymentCompletedBy;
  }

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: record.pk, sk: record.sk },
    UpdateExpression: isPaid
      ? 'SET #paymentStatus = :paymentStatus, paymentDate = :paymentDate, paymentCompletedAt = :paymentCompletedAt, paymentCompletedBy = :paymentCompletedBy, updatedAt = :updatedAt, updatedBy = :updatedBy'
      : 'SET #paymentStatus = :paymentStatus, updatedAt = :updatedAt, updatedBy = :updatedBy REMOVE paymentDate, paymentCompletedAt, paymentCompletedBy',
    ExpressionAttributeNames: { '#paymentStatus': 'paymentStatus' },
    ExpressionAttributeValues: isPaid
      ? { ':paymentStatus': status, ':paymentDate': paymentDate, ':paymentCompletedAt': updatedAt, ':paymentCompletedBy': member, ':updatedAt': updatedAt, ':updatedBy': member }
      : { ':paymentStatus': status, ':updatedAt': updatedAt, ':updatedBy': member },
    ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
  }));
  return response(200, { record: await publicRecord(updatedRecord) });
}

async function deleteExpense(event, member) {
  const id = event.pathParameters?.id;
  if (!id) return response(404, { message: '지출 기록을 찾을 수 없습니다.' });

  const record = await findExpense(id);
  if (!record) return response(404, { message: '지출 기록을 찾을 수 없습니다.' });

  if (record.person !== member) return response(403, { message: '지출을 등록한 멤버만 삭제할 수 있습니다.' });

  await ddb.send(new DeleteCommand({
    TableName: tableName,
    Key: { pk: record.pk, sk: record.sk },
    ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
  }));

  if (record.receiptKey) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: record.receiptKey }));
    } catch (error) {
      console.error('Receipt cleanup failed', error.message);
    }
  }
  return response(200, { deleted: true });
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.rawPath || event.path;
  if (method === 'OPTIONS') return response(204, {});
  try {
    if (method === 'POST' && path === '/auth') return await authenticate(event);
    if (method === 'POST' && path === '/auth/pin') return await authenticateWithPersonalPin(event);
    if (method === 'POST' && path === '/auth/pin/setup') return await setPersonalPin(event);
    if (method === 'POST' && path === '/auth/passkey/register/options') return await createPasskeyRegistrationOptions(event);
    if (method === 'POST' && path === '/auth/passkey/register/verify') return await verifyPasskeyRegistration(event);
    if (method === 'POST' && path === '/auth/passkey/add/options') return await createAdditionalPasskeyRegistrationOptions(event);
    if (method === 'POST' && path === '/auth/passkey/add/verify') return await verifyAdditionalPasskeyRegistration(event);
    if (method === 'POST' && path === '/auth/passkey/options') return await createPasskeyAuthenticationOptions(event);
    if (method === 'POST' && path === '/auth/passkey/verify') return await verifyPasskeyAuthentication(event);
    const member = getSessionMember(event);
    if (method === 'GET' && path === '/records') return response(200, { records: await listRecords(member) });
    if (method === 'GET' && path === '/media') return response(200, await listMedia(event));
    if (method === 'GET' && /^\/media\/[^/]+$/.test(path)) return await getMedia(event);
    if (method === 'POST' && path === '/media/photos') return await savePhoto(event, member);
    if (method === 'POST' && path === '/media/videos') return await saveVideo(event, member);
    if (method === 'PATCH' && /^\/media\/[^/]+$/.test(path)) return await updateMedia(event, member);
    if (method === 'DELETE' && /^\/media\/[^/]+$/.test(path)) return await deleteMedia(event, member);
    if (method === 'POST' && path === '/expenses/scan') return await scanAndSave(event, member);
    if (method === 'POST' && path === '/incomes/scan') return await scanIncomeAndSave(event);
    if (method === 'PATCH' && /^\/expenses\/[^/]+\/payment$/.test(path)) return await updatePaymentStatus(event, member);
    if (method === 'PATCH' && /^\/expenses\/[^/]+$/.test(path)) return await updateExpense(event, member);
    if (method === 'DELETE' && /^\/expenses\/[^/]+$/.test(path)) return await deleteExpense(event, member);
    return response(404, { message: '요청한 기능을 찾을 수 없습니다.' });
  } catch (error) {
    console.error(error);
    return response(error.message?.includes('로그인') ? 401 : 500, { message: error.message || '서버 오류가 발생했습니다.' });
  }
};
