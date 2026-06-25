---
name: istio
description: Inspect and troubleshoot Istio service mesh — traffic, mTLS, VirtualServices, DestinationRules, Gateways, circuit breakers, Envoy proxy — via istioctl and kubectl.
---
# Istio Service Mesh

Use `run_command`. Confirm cluster context first: `kubectl config current-context`. Istio lives in the `istio-system` namespace. Read-only first; confirm before mutating.

## Health check (start here)
```bash
istioctl version                          # client + control plane versions
istioctl verify-install                   # validates Istio install
kubectl get pods -n istio-system          # istiod, ingress/egress gateways should be Running
istioctl proxy-status                     # sync status of ALL sidecars (SYNCED = healthy)
```

## Traffic & routing
```bash
# List VirtualServices and DestinationRules
kubectl get virtualservice,destinationrule -A
kubectl describe virtualservice <name> -n <ns>     # routing rules, weights, retries, timeouts
kubectl describe destinationrule <name> -n <ns>    # subsets, traffic policy, mTLS mode

# List Gateways (ingress entry points)
kubectl get gateway -A
kubectl describe gateway <name> -n <ns>

# Check effective route for a pod
istioctl experimental describe pod <pod-name>.<namespace>
```

## mTLS & security
```bash
# Check mTLS mode between services
istioctl experimental authz check <pod>.<ns>

# PeerAuthentication (mTLS policy)
kubectl get peerauthentication -A
kubectl describe peerauthentication <name> -n <ns>   # STRICT / PERMISSIVE / DISABLE

# AuthorizationPolicy (who can call what)
kubectl get authorizationpolicy -A
kubectl describe authorizationpolicy <name> -n <ns>
```

## Envoy proxy (sidecar) inspection
```bash
# Proxy config for a specific pod — most powerful debugging tool
istioctl proxy-config all <pod> -n <ns>

# Specific views
istioctl proxy-config listener <pod> -n <ns>      # what ports the proxy listens on
istioctl proxy-config route <pod> -n <ns>         # routing table
istioctl proxy-config cluster <pod> -n <ns>       # upstream clusters (services)
istioctl proxy-config endpoint <pod> -n <ns>      # healthy endpoints per cluster
istioctl proxy-config secret <pod> -n <ns>        # TLS certs and expiry

# Envoy access logs for a pod (if enabled)
kubectl logs <pod> -n <ns> -c istio-proxy --tail=100
```

## Metrics (Prometheus / istio)
```bash
# Request rate, error rate, latency — from istiod's Prometheus scrape
# If Prometheus is installed:
kubectl port-forward svc/prometheus -n istio-system 9090 &
# Then query: istio_requests_total, istio_request_duration_milliseconds

# Via kubectl top (basic)
kubectl top pods -n <ns>
```

## Ingress gateway
```bash
# Get external IP
kubectl get svc istio-ingressgateway -n istio-system

# Logs (traffic in/out)
kubectl logs -l app=istio-ingressgateway -n istio-system --tail=100

# Test routing end-to-end
export INGRESS_HOST=$(kubectl get svc istio-ingressgateway -n istio-system -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -v -H "Host: <your-host>" http://$INGRESS_HOST/
```

## Circuit breakers & outlier detection
```bash
# In DestinationRule spec:
# trafficPolicy.connectionPool — max connections, pending requests, retries
# trafficPolicy.outlierDetection — consecutiveErrors, interval, baseEjectionTime
kubectl describe destinationrule <name> -n <ns> | grep -A 20 trafficPolicy
```

## Common issues & fixes
| Symptom | Check |
|---|---|
| 503 / connection refused | `istioctl proxy-config endpoint <pod>` — healthy endpoints? `proxy-status` — SYNCED? |
| mTLS handshake fail | `proxy-config secret` — cert expired? PeerAuthentication mismatch (STRICT vs PERMISSIVE)? |
| Traffic not matching VirtualService | `istioctl experimental describe pod` — is sidecar injected? label `istio-injection=enabled` on ns? |
| High latency | `proxy-config route` — check retries/timeout config; `istio_request_duration_milliseconds` in Prometheus |
| Sidecar not injected | `kubectl get ns <ns> --show-labels` — needs `istio-injection=enabled`; restart pods after labelling |
| Gateway 404 | `kubectl describe gateway` + `virtualservice` — hosts/port/protocol match? `proxy-config route` on ingress pod |

Pair with **kubernetes** skill for pod/service ops and **monitoring** or **aws** for metrics dashboards.
