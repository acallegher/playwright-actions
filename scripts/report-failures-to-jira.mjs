
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY,
  GITHUB_SERVER_URL,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
} = process.env;

const reportPath = path.resolve(
  process.cwd(),
  'test-results/junit.xml'
);

console.log('[DEBUG] Script de integração com Jira iniciado.');
console.log(`[DEBUG] Diretório atual: ${process.cwd()}`);
console.log(`[DEBUG] Relatório JUnit: ${reportPath}`);

// 1. Validar variáveis de ambiente
for (const name of [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
]) {
  if (!process.env[name]) {
    throw new Error(`Variável de ambiente ausente: ${name}`);
  }
}

// 2. Validar se o relatório existe
if (!fs.existsSync(reportPath)) {
  throw new Error(
    `Relatório JUnit não encontrado: ${reportPath}`
  );
}

// 3. Ler e interpretar o XML
const xmlContent = fs.readFileSync(reportPath, 'utf8');

console.log(
  `[DEBUG] Relatório lido: ${xmlContent.length} caracteres.`
);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
});

const xml = parser.parse(xmlContent);
const failedTests = [];

function getText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    return String(value['#text'] ?? '');
  }
  return '';
}

function collectTests(node) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectTests(item);
    }
    return;
  }

  const isFailedTest =
    node['@_name'] &&
    (
      node.failure != null ||
      node.error != null ||
      node['system-err'] != null
    );

  if (isFailedTest) {
    const failureNode =
      node.failure ?? node.error ?? node['system-err'];

    const failure = Array.isArray(failureNode)
      ? failureNode[0]
      : failureNode;

    failedTests.push({
      name: String(node['@_name']),
      className: String(node['@_classname'] ?? ''),
      message: String(
        failure?.['@_message'] ??
        failure?.['@_type'] ??
        'Falha no teste'
      ),
      details: getText(failure),
    });

    return;
  }

  for (const value of Object.values(node)) {
    collectTests(value);
  }
}

collectTests(xml);

console.log(
  `[DEBUG] Total de testes com falha: ${failedTests.length}`
);

if (failedTests.length === 0) {
  console.log(
    '[DEBUG] Nenhuma falha encontrada no XML. ' +
    'Verifique se o JUnit foi gerado e contém elementos <failure> ou <error>.'
  );
  process.exit(0);
}

// 4. Preparar autenticação Jira
const baseUrl = JIRA_BASE_URL.replace(/\/+$/, '');

const auth = Buffer.from(
  `${JIRA_EMAIL}:${JIRA_API_TOKEN}`
).toString('base64');

async function jiraRequest(endpoint, options = {}) {
  console.log(`[DEBUG] Requisição Jira: ${endpoint}`);

  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Jira retornou HTTP ${response.status}: ${body}`
    );
  }

  return body ? JSON.parse(body) : {};
}

const runUrl =
  GITHUB_SERVER_URL &&
  GITHUB_REPOSITORY &&
  GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL.replace(/\/+$/, '')}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : 'Execução local';

// 5. Criar um Bug para cada teste com falha
async function createBug(test) {
  const summary =
    `[Playwright] ${test.className} - ${test.name}`
      .replace(/\s+/g, ' ')
      .slice(0, 250);

  const descriptionLines = [
    `Teste automatizado: ${test.name}`,
    `Classe: ${test.className}`,
    `Mensagem: ${test.message}`,
    `Detalhes: ${test.details || 'Sem detalhes adicionais.'}`,
    `Execução GitHub Actions: ${runUrl}`,
  ];

  const description = descriptionLines
    .join('\n')
    .slice(0, 10000);

  const issue = await jiraRequest('/rest/api/3/issue', {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        project: {
          key: JIRA_PROJECT_KEY,
        },
        summary,
        issuetype: {
          name: 'Bug',
        },
        labels: ['playwright-auto'],
        description: {
          type: 'doc',
          version: 1,
          content: description.split('\n').map((line) => ({
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: line || ' ',
              },
            ],
          })),
        },
      },
    }),
  });

  console.log(
    `[SUCCESS] Bug criado: ${issue.key} — ${summary}`
  );
}

let creationErrors = 0;

for (const test of failedTests) {
  console.log(
    `[DEBUG] Criando Bug para o teste: ${test.name}`
  );

  try {
    await createBug(test);
  } catch (error) {
    creationErrors++;

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `[ERROR] Falha ao criar Bug para "${test.name}": ${message}`
    );
  }
}

if (creationErrors > 0) {
  throw new Error(
    `Não foi possível criar ${creationErrors} Bug(s) no Jira.`
  );
}

console.log(
  '[SUCCESS] Integração com Jira concluída.'
);
