// Use the upload step's immutable artifact ID; avoid eventual-consistency name lookup.
module.exports = async function deployPages({github, core, context, artifactId,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollLimit = 120}) {
    const id = Number(artifactId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Missing Pages artifact ID');
    const repo = context.repo;
    const {data: deployment} = await github.request('POST /repos/{owner}/{repo}/pages/deployments', {
        ...repo, artifact_id: id, pages_build_version: context.sha, oidc_token: await core.getIDToken()
    });
    const deploymentId = deployment.id || deployment.status_url?.split('/').pop() || context.sha;
    const params = {...repo, deployment_id: deploymentId};
    core.info(`Created Pages deployment ${deploymentId} from artifact ${id}`);
    let errors = 0;
    const terminal = new Set(['deployment_failed', 'deployment_perms_error', 'deployment_content_failed',
        'deployment_cancelled', 'deployment_lost']);
    try {
        for (let attempt = 0; attempt < pollLimit; attempt++) {
            await sleep(5000);
            let status;
            try {
                ({data: {status}} = await github.request('GET /repos/{owner}/{repo}/pages/deployments/{deployment_id}', params));
                errors = 0;
            } catch (error) {
                if (![404, 429, 500, 502, 503, 504].includes(error.status) || ++errors >= 10) throw error;
                core.warning(`Pages status temporarily unavailable (${error.status})`);
                continue;
            }
            core.info(`Pages status: ${status}`);
            if (status === 'succeed') {
                core.setOutput('page_url', deployment.page_url);
                return;
            }
            if (terminal.has(status)) throw new Error(`Pages deployment failed: ${status}`);
        }
        throw new Error('Timed out waiting for Pages deployment');
    } catch (error) {
        try {
            await github.request('POST /repos/{owner}/{repo}/pages/deployments/{deployment_id}/cancel', params);
        } catch {
            core.warning('Unable to cancel the failed or timed-out Pages deployment');
        }
        throw error;
    }
};
