package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
)

type deployment struct {
	Metadata struct {
		Name       string
		Generation int64
	}
	Spec struct {
		Replicas *int
		Template struct {
			Spec struct{ Containers []struct{ Image string } }
		}
	}
	Status struct {
		ObservedGeneration int64
		Replicas           int
		UpdatedReplicas    int
		AvailableReplicas  int
		Conditions         []struct{ Type, Status, Reason string }
	}
}

func workload(item deployment) Workload {
	desired := 1
	if item.Spec.Replicas != nil {
		desired = *item.Spec.Replicas
	}
	w := Workload{Name: item.Metadata.Name, Images: []string{}, Ready: item.Status.AvailableReplicas, Desired: desired, Status: "deploying"}
	for _, c := range item.Spec.Template.Spec.Containers {
		w.Images = append(w.Images, c.Image)
	}
	if item.Status.ObservedGeneration >= item.Metadata.Generation {
		if desired == 0 {
			w.Status = "scaled down"
		} else if w.Ready >= desired && item.Status.UpdatedReplicas == desired && item.Status.Replicas == desired {
			w.Status = "healthy"
		}
		for _, c := range item.Status.Conditions {
			if (c.Type == "Progressing" && c.Status == "False") || (c.Type == "ReplicaFailure" && c.Status == "True") {
				w.Status = "unhealthy"
			}
		}
	}
	return w
}

func (d *Dashboard) cluster(ctx context.Context, r *Result) error {
	if r.Namespace == "" {
		r.Health = "not applicable"
		return nil
	}
	if d.kube == nil {
		return fmt.Errorf("not connected (run in cluster)")
	}
	token, err := os.ReadFile(d.kubeTokenFile)
	if err != nil {
		return fmt.Errorf("service account token unavailable")
	}
	items := []deployment{}
	continuation := ""
	for {
		var list struct {
			Items    []deployment
			Metadata struct{ Continue string }
		}
		endpoint := d.kubeURL + "/apis/apps/v1/namespaces/" + r.Namespace + "/deployments?limit=100"
		if continuation != "" {
			endpoint += "&continue=" + url.QueryEscape(continuation)
		}
		if err := getJSON(ctx, d.kube, endpoint, strings.TrimSpace(string(token)), &list); err != nil {
			return err
		}
		items = append(items, list.Items...)
		if list.Metadata.Continue == "" {
			break
		}
		if list.Metadata.Continue == continuation {
			return fmt.Errorf("invalid Kubernetes pagination")
		}
		continuation = list.Metadata.Continue
	}
	if len(items) == 0 {
		r.Health = "not deployed"
		return nil
	}
	r.Health = "healthy"
	for _, item := range items {
		w := workload(item)
		r.Workloads = append(r.Workloads, w)
		if w.Status == "unhealthy" {
			r.Health = "unhealthy"
		} else if w.Status != "healthy" && r.Health != "unhealthy" {
			r.Health = "degraded"
		}
	}
	return nil
}
