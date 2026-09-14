package main

import (
	"context"
	"fmt"
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
	if d.kube == nil {
		return fmt.Errorf("not connected (run in cluster)")
	}
	token, err := os.ReadFile(d.kubeTokenFile)
	if err != nil {
		return fmt.Errorf("service account token unavailable")
	}
	var list struct{ Items []deployment }
	if err := getJSON(ctx, d.kube, d.kubeURL+"/apis/apps/v1/namespaces/"+r.Namespace+"/deployments", strings.TrimSpace(string(token)), &list); err != nil {
		return err
	}
	if len(list.Items) == 0 {
		r.Health = "not deployed"
		return nil
	}
	r.Health = "healthy"
	for _, item := range list.Items {
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
