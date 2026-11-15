const test = require('node:test');
const assert = require('node:assert/strict');
const deploy = require('../scripts/deploy_pages.cjs');

function scenario(statuses) {
    const requests = [], outputs = {};
    return {
        requests, outputs,
        args: {
            artifactId: '12345', context: {repo: {owner: 'test', repo: 'events'}, sha: 'build-sha'},
            sleep: async () => {}, pollLimit: 3,
            core: {getIDToken: async () => 'test-oidc', info() {}, warning() {}, setOutput: (k, v) => outputs[k] = v},
            github: {request: async (route, params) => {
                requests.push({route, params});
                if (route.endsWith('/cancel')) return {data: {}};
                if (route.startsWith('POST ')) return {data: {id: 'deployment-id', page_url: 'https://example.test/'}};
                const next = statuses.shift() || 'building';
                if (next instanceof Error) throw next;
                return {data: {status: next}};
            }}
        }
    };
}

test('deploys the uploaded ID without listing artifacts, and waits for success', async () => {
    const s = scenario(['building', 'succeed']);
    await deploy(s.args);
    assert.deepEqual(s.requests[0].params, {owner: 'test', repo: 'events', artifact_id: 12345,
        pages_build_version: 'build-sha', oidc_token: 'test-oidc'});
    assert.equal(s.requests.filter(r => r.route.startsWith('POST ')).length, 1);
    assert.ok(s.requests.every(r => r.route.includes('/pages/deployments')));
    assert.equal(s.outputs.page_url, 'https://example.test/');
});

test('retries a transient status error without creating another deployment', async () => {
    const s = scenario([Object.assign(new Error('Unavailable'), {status: 503}), 'succeed']);
    await deploy(s.args);
    assert.equal(s.requests.filter(r => r.route.startsWith('POST ')).length, 1);
    assert.equal(s.outputs.page_url, 'https://example.test/');
});

test('failure and timeout fail the job and attempt cancellation', async () => {
    for (const statuses of [['deployment_content_failed'], []]) {
        const s = scenario(statuses);
        await assert.rejects(deploy(s.args), /failed|Timed out/);
        assert.equal(s.requests.at(-1).route.endsWith('/cancel'), true);
        assert.deepEqual(s.outputs, {});
    }
});

test('missing upload ID and creation errors never trigger another deployment', async () => {
    const s = scenario([]);
    await assert.rejects(deploy({...s.args, artifactId: ''}), /Missing Pages artifact ID/);
    assert.equal(s.requests.length, 0);
    let calls = 0;
    s.args.github.request = async () => {calls++; throw new Error('Create failed');};
    await assert.rejects(deploy(s.args), /Create failed/);
    assert.equal(calls, 1);
});
