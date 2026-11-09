import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseEnv, unknownVariables } from '../src/config-schema.js';

/**
 * The Kubernetes example (examples/kubernetes, O3 of the 0.10 review), checked without a cluster: the manifests parse
 * (as YAML 1.1, like Kubernetes), and the points Steward depends on are there – one replica, Recreate, non-root with
 * fsGroup 1000, a read-only root, the probes of docs/INSTALL.md with Host: localhost, secrets as files, and only
 * environment variables Steward knows, with values it accepts.
 */
const DIR = path.resolve(__dirname, '..', '..', 'examples', 'kubernetes');
const load = (file: string): any[] =>
  YAML.parseAllDocuments(fs.readFileSync(path.join(DIR, file), 'utf8'), { version: '1.1' }).map((d) => {
    expect(d.errors, file).toEqual([]);
    return d.toJSON();
  });
const one = (file: string) => {
  const docs = load(file);
  expect(docs, file).toHaveLength(1);
  return docs[0];
};

const deployment = one('deployment.yaml');
const pod = deployment.spec.template.spec;
const container = pod.containers[0];

describe('the Kubernetes example', () => {
  it('lists only files that exist, and every manifest has a kind and a name', () => {
    for (const k of ['kustomization.yaml', 'postgres/kustomization.yaml']) {
      const kz = one(k);
      for (const r of [...(kz.resources ?? []), ...(kz.patches ?? []).map((p: any) => p.path)])
        expect(fs.existsSync(path.resolve(DIR, path.dirname(k), r)), `${k}: ${r}`).toBe(true);
    }
    for (const f of ['deployment.yaml', 'pvc.yaml', 'service.yaml', 'ingress.yaml', 'secret.example.yaml', 'postgres/deployment-patch.yaml'])
      for (const d of load(f)) expect([d.apiVersion, d.kind, d.metadata?.name].every(Boolean), f).toBe(true);
  });

  it('runs one pod, stopping the old one first', () => {
    expect(deployment).toMatchObject({ apiVersion: 'apps/v1', kind: 'Deployment', spec: { replicas: 1, strategy: { type: 'Recreate' } } });
    expect(deployment.spec.selector.matchLabels).toEqual(deployment.spec.template.metadata.labels);
    expect(pod.terminationGracePeriodSeconds).toBeGreaterThan(25); // SM_SHUTDOWN_GRACE_SECONDS
    expect(pod.enableServiceLinks).toBe(false);
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  it('runs as uid 1000 without privileges, on a read-only root', () => {
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(container.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    const mounts = Object.fromEntries(container.volumeMounts.map((m: any) => [m.mountPath, m.name]));
    expect(mounts['/data']).toBe('data');
    expect(mounts['/tmp']).toBe('tmp');
    const volumes = Object.fromEntries(pod.volumes.map((v: any) => [v.name, v]));
    expect(volumes.data.persistentVolumeClaim.claimName).toBe(one('pvc.yaml').metadata.name);
    expect(volumes.tmp.emptyDir).toBeTruthy();
    expect(container.resources.requests).toMatchObject({ cpu: expect.any(String), memory: expect.any(String) });
    expect(container.resources.limits.memory).toBeTruthy();
    expect(one('pvc.yaml').spec.accessModes).toEqual(['ReadWriteOnce']);
  });

  it('pins the image version', () => {
    expect(container.image).toMatch(/^ghcr\.io\/vxrz\/steward:\d+\.\d+\.\d+$/);
  });

  it('probes /api/health for liveness and /api/ready/traffic for readiness, with Host: localhost (docs/INSTALL.md)', () => {
    const port = container.ports.find((p: any) => p.containerPort === 4310);
    expect(port).toBeTruthy();
    for (const [probe, p] of [
      ['livenessProbe', '/api/health'],
      ['readinessProbe', '/api/ready/traffic'],
      ['startupProbe', '/api/health'],
    ]) {
      const get = container[probe!].httpGet;
      expect(get.path, probe).toBe(p);
      expect([port.name, port.containerPort], probe).toContain(get.port);
      expect(get.httpHeaders, probe).toEqual([{ name: 'Host', value: 'localhost' }]);
    }
    // the same probes as the guide shows
    const install = fs.readFileSync(path.resolve(DIR, '..', '..', 'docs', 'INSTALL.md'), 'utf8');
    expect(install).toContain('readinessProbe:\n  httpGet: { path: /api/ready/traffic');
    expect(JSON.stringify(container)).not.toContain('"/api/ready"');
  });

  it('mounts the master passphrase from a Secret as a file, readable by the group only', () => {
    const volume = pod.volumes.find((v: any) => v.secret);
    const secret = one('secret.example.yaml');
    expect(volume.secret).toMatchObject({ secretName: secret.metadata.name, defaultMode: 0o440, optional: true });
    const mount = container.volumeMounts.find((m: any) => m.name === volume.name);
    expect(mount.readOnly).toBe(true);
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]));
    expect(env.SM_MASTER_PASSPHRASE_FILE).toBe(`${mount.mountPath}/${Object.keys(secret.stringData)[0]}`);
    expect(env.SM_MASTER_PASSPHRASE).toBeUndefined();
    // not applied by kustomize: a placeholder must never end up as the passphrase
    expect(one('kustomization.yaml').resources).not.toContain('secret.example.yaml');
  });

  it('sets only variables Steward knows, with values it accepts – also in the PostgreSQL overlay', () => {
    const patch = one('postgres/deployment-patch.yaml').spec.template.spec.containers[0];
    for (const list of [container.env, patch.env]) {
      const env = Object.fromEntries(list.map((e: any) => [e.name, String(e.value)]));
      expect(unknownVariables(env)).toEqual([]);
      // the file variables point at files; their values are checked at start-up
      const values = Object.fromEntries(Object.entries(env).filter(([k]) => !k.endsWith('_FILE')));
      expect(() => parseEnv(values)).not.toThrow();
    }
    const env = Object.fromEntries(patch.env.map((e: any) => [e.name, e.value]));
    expect(env.SM_DATABASE_URL).toBeUndefined(); // a secret: from the file
    const mount = patch.volumeMounts[0];
    expect(env.SM_DATABASE_URL_FILE.startsWith(`${mount.mountPath}/`)).toBe(true);
    expect(one('postgres/deployment-patch.yaml').spec.template.spec.volumes[0].secret.defaultMode).toBe(0o440);
  });

  it('routes the Service and the Ingress to the pod', () => {
    const service = one('service.yaml');
    expect(service.spec.selector).toEqual(deployment.spec.template.metadata.labels);
    expect(container.ports.map((p: any) => p.name)).toContain(service.spec.ports[0].targetPort);
    const ingress = one('ingress.yaml');
    const backend = ingress.spec.rules[0].http.paths[0].backend.service;
    expect(backend.name).toBe(service.metadata.name);
    expect(backend.port.name).toBe(service.spec.ports[0].name);
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]));
    expect(env.SM_ALLOWED_HOSTS).toBe(ingress.spec.rules[0].host);
    expect(env.SM_PUBLIC_URL).toBe(`https://${ingress.spec.rules[0].host}`);
  });
});
