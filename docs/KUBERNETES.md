# Kubernetes

Steward reads Kubernetes clusters (also OpenShift, Rancher, AKS, EKS, GKE) with a **read-only service account**. It never changes anything in a cluster.

| What                                                                      | Where                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Which images run in an application's namespaces – tech stack, end of life | application components of type **Kubernetes namespace** (read every 6 hours, or _Read now_) |
| Are the deployments ready, is a pod crash-looping                         | monitors with the check type **Kubernetes deployments**                                     |
| Deployments, pods and certificates of several namespaces at a glance      | the example process _Kubernetes – namespace health_ and the dashboard **Kubernetes**        |

## Connect a cluster

1. Create the service account and the read-only role below (one `ClusterRole`, bound per namespace or cluster-wide).
2. In Steward, _Platforms → New → Kubernetes cluster (read-only)_. Base URL: the API server, e.g. `https://k8s-api.example.com:6443`. Credential **token**: the service account token. For a private CA, add it under the platform's HTTP settings. The outbound policy must allow the API server.
3. _Test connection_ calls `GET /version`.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: steward-reader, namespace: steward }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: steward-reader }
rules:
  - apiGroups: ['apps']
    resources: ['deployments']
    verbs: ['get', 'list']
  - apiGroups: ['']
    resources: ['pods']
    verbs: ['get', 'list']
  - apiGroups: ['cert-manager.io']
    resources: ['certificates']
    verbs: ['get', 'list']
---
# per namespace Steward should read (or a ClusterRoleBinding for all of them)
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: steward-reader, namespace: shop-prod }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: steward-reader }
subjects: [{ kind: ServiceAccount, name: steward-reader, namespace: steward }]
```

A token: `kubectl create token steward-reader -n steward --duration=8760h` (or a long-lived token secret of type `kubernetes.io/service-account-token`). No secrets, config maps or logs are read – the role does not allow them.

## Namespaces of an application

On the application page, _Components → Add_: type **Kubernetes namespace**, the namespace as name (`shop-prod`), its **environment**, and the **cluster** (a Kubernetes platform you may use). Steward reads it every 6 hours – with the rights of whoever last changed the component – and on _Read now_ (refresh icon):

- **Deployments** with ready and wanted replicas (`web 3/3, worker 1/2`) and their images (init containers too).
- **Pods that are not well**: waiting with a reason such as `CrashLoopBackOff` or `ImagePullBackOff`, failed, pending for more than 10 minutes, or 5 restarts and more.
- **cert-manager certificates** with their end (`status.notAfter`); those ending within 30 days are shown. Without cert-manager in the cluster the line says so; TLS secrets without cert-manager are not read.
- **Tech stack**: each image is mapped to an endoflife.date product and the version of its tag (`postgres:16.4-alpine` → PostgreSQL 16.4, `node:24-alpine` → Node.js 24, `nginx:1.27.3` → nginx 1.27.3). The entries have the source _read from the cluster_; they follow the images, and an entry entered by hand wins. When several images run one product, the oldest version counts. **Images Steward cannot map** (your own, e.g. `ghcr.io/acme/shop-web`) are listed as _not mapped_ instead of being guessed.

**Own images.** _Applications → End of life → settings_, _Own container images_: one line per image and product, e.g. `ghcr.io/acme/base-node = nodejs`; the version comes from the tag. They come before the built-in list (official images such as postgres, mysql, mariadb, mongo, redis, valkey, rabbitmq, elasticsearch, nginx, httpd, haproxy, traefik, node, python, php, ruby, golang, eclipse-temurin, tomcat, alpine, ubuntu, debian, grafana, prometheus, keycloak, kafka; `shared/src/kubernetes.ts`). A rule matches the end of the repository, so `acme/postgres-backup` is not taken for PostgreSQL.

End-of-life messages, the scorecard part _Tech stack_ and the end-of-life overview then cover the namespaces like any component ([APPLICATIONS.md](APPLICATIONS.md#end-of-life)). A read that changes the stack is audited as `application.component_cluster_read`; a read that fails keeps the stack and shows why (`no permission (403)` …).

## Monitor check

```yaml
checks:
  - { id: web, name: Shop web, type: kubernetes, platform: Kubernetes (prod), namespace: shop-prod, deployment: web }
  - { id: all, name: Shop namespace, type: kubernetes, platform: Kubernetes (prod), namespace: shop-prod }
```

Up when every deployment (or the one named) has all replicas ready; **degraded** when fewer are ready or a pod of it is not well; **down** when a deployment wants replicas and none is ready. The message names them: `Kubernetes: shop-prod/worker – worker 1/2 ready, pod worker-5d4b-y2 CrashLoopBackOff (14 restarts)`. Dependencies, root causes, maintenance windows and acknowledgements work as for every check ([MONITORS.md](MONITORS.md)).

## Demo and tests

Demo mode adds **Kubernetes (demo)**, a simulated API server (`server/src/mock/mockKubernetes.ts`) with the namespaces `shop-prod` (a crash-looping worker, a certificate ending in 10 days) and `shop-test`. Tests: `server/test/kubernetes.test.ts` and the example run in `server/test/examples.test.ts`.
