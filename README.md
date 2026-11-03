# Deploy on Kubernetes

Five Deployments, one namespace. Each Deployment is a body part. The head service shows a healthy reference robot next to a live robot. Delete a Deployment and only that part changes. Put the Deployment back and the part turns green again.

| Folder | Deployment | Service | Port | Body part |
| --- | --- | --- | --- | --- |
| `one/` | `legs` | `legs` | 3001 | Both legs |
| `two/` | `hands` | `hands` | 3002 | Both arms |
| `three/` | `stomach` | `stomach` | 3003 | Belly and heart |
| `four/` | `eyes` | `eyes` | 3004 | Face |
| `five/` | `head` | `head` | 3005 | Head, ears, and antenna |

Everything lands in the `robot` namespace. Images are `robot-legs:1.0.0`, `robot-hands:1.0.0`, `robot-stomach:1.0.0`, `robot-eyes:1.0.0`, and `robot-head:1.0.0`, with `imagePullPolicy: IfNotPresent`.

## 1. Build the images

From `robot-microservices`:

```bash
./scripts/build-multiarch.sh
```

That loads the five images for the machine you are on. The Dockerfiles are `node:22-alpine` with no native addons, so the same build runs on Apple Silicon and on Intel or AMD Ubuntu.

On a cluster that cannot see your local Docker images, push them and point the manifests at the registry:

```bash
REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com PUSH=1 ./scripts/build-multiarch.sh
./scripts/set-ecr-registry.sh 123456789012.dkr.ecr.us-east-1.amazonaws.com
```

`PUSH=1` builds `linux/amd64` and `linux/arm64`. When the registry host ends in `amazonaws.com`, the script logs in and creates the ECR repositories. `set-ecr-registry.sh` rewrites each `image:` line and sets `imagePullPolicy: Always`.

For kind, load the local tags instead of pushing:

```bash
kind load docker-image \
  robot-legs:1.0.0 \
  robot-hands:1.0.0 \
  robot-stomach:1.0.0 \
  robot-eyes:1.0.0 \
  robot-head:1.0.0
```

## 2. Apply the manifests

```bash
kubectl apply -k .
kubectl -n robot get pods,svc
```

`kubectl apply -k .` creates the namespace and the five Deployments, Services, and Ingresses. It does not install Istio or Prometheus. Those manifests are under `platform/` and stay out of this apply on purpose.

One part can be applied on its own after the namespace exists:

```bash
kubectl apply -f platform/namespace.yaml
kubectl apply -k one
```

Wait until every pod is `Running`:

```bash
kubectl -n robot rollout status deployment/legs
kubectl -n robot rollout status deployment/hands
kubectl -n robot rollout status deployment/stomach
kubectl -n robot rollout status deployment/eyes
kubectl -n robot rollout status deployment/head
```

## 3. Open the robot

Port-forward the head service:

```bash
kubectl -n robot port-forward svc/head 3005:3005
```

Open http://127.0.0.1:3005.

Or use Ingress. The class in each `ingress.yaml` is `nginx`. Hosts:

- `head.robot.local`
- `legs.robot.local`
- `hands.robot.local`
- `stomach.robot.local`
- `eyes.robot.local`

Point those names at the ingress address. Every host serves the same comparison page.

## 4. Check that a part follows its Deployment

```bash
kubectl -n robot delete deployment legs
```

Within a couple of seconds both feet on the live robot switch to the down colors, and the line under it reads `LEG SERVICE IS DOWN`. The reference robot stays green. The other four parts stay in their healthy colors.

Put the legs back:

```bash
kubectl apply -k one
```

The feet return to green and the line changes to `ALL SERVICES ARE HEALTHY`.

Scale one part without touching the others:

```bash
kubectl -n robot scale deployment/hands --replicas=3
```

## 5. Deploy with Argo CD

Point the Applications at your Git repository, then apply the project and the Applications. Argo CD must already be installed, and the Applications are created in the `argocd` namespace.

```bash
./scripts/set-git-repo.sh https://github.com/you/robot-microservices.git
kubectl apply -f platform/argocd/project.yaml
kubectl apply -f platform/argocd/applications.yaml
```

`robot-legs`, `robot-hands`, `robot-stomach`, `robot-eyes`, and `robot-head` sync on their own into the `robot` namespace. `robot-istio` and `robot-monitoring` are in the same file and do not auto-sync. Leave them alone unless that cluster already has the Istio and Prometheus CRDs.

The pods still need to pull the images from step 1. Commit the registry image names before Argo syncs, or load the images onto the nodes.
