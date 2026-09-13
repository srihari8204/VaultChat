# Cluster bootstrap

Run once, in this order, after `terraform apply`. Everything here is
cluster-wide plumbing that the application chart assumes exists.

```bash
doctl kubernetes cluster kubeconfig save crazzychat-prod
```

## 1. Namespaces

The two SFU namespaces are not cosmetic — they are what keeps a leaked LiveKit
credential contained to one of the two deployments.

```bash
kubectl create ns crazzychat
kubectl create ns media-calls
kubectl create ns media-golive
kubectl create ns monitoring
```

## 2. Sealed Secrets

```bash
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets -n kube-system
```

**Back the controller key up before you seal anything.** Without it, a rebuilt
cluster cannot decrypt a single secret and every value has to be re-minted —
including `VAULTCHAT_MASTER_KEY` and `VAULTCHAT_LOOKUP_PEPPER`, which cannot be
re-minted at all without losing access to the data they protect.

```bash
kubectl -n kube-system get secret \
  -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > sealed-secrets-key.backup.yaml
# then move it somewhere offline. Not this repo.
```

## 3. ingress-nginx

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  -f ingress-nginx-values.yaml
```

## 4. cert-manager

```bash
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --set crds.enabled=true
kubectl apply -f clusterissuer.yaml
```

## 5. Monitoring and autoscaling

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack -n monitoring

helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda -n keda --create-namespace

# coturn reads its TLS certificate once at startup, so a cert-manager renewal
# without a restart leaves it serving an expired one — silently, 90 days later.
helm repo add stakater https://stakater.github.io/stakater-charts
helm install reloader stakater/reloader -n kube-system
```

## 6. The application

```bash
cd ../charts
helm upgrade --install crazzychat crazzychat -n crazzychat \
  --set image.tag=<sha> --set migrator.tag=<sha> -f ../envs/prod/values.yaml

helm upgrade --install livekit-calling livekit -n media-calls -f livekit/instances/calling.yaml
helm upgrade --install livekit-golive  livekit -n media-golive -f livekit/instances/golive.yaml
helm upgrade --install coturn coturn -n media-calls
```
