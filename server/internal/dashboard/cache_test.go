package dashboard

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestCacheStartsEmptyAndKeepsLatestSnapshot(t *testing.T) {
	cache := &Cache{}
	if _, ready := cache.Latest(); ready {
		t.Fatal("new process must start without a snapshot")
	}
	current := Snapshot{Environment: "current", UpdatedAt: time.Now(), Apps: []Result{}}
	cache.Publish(current)
	cache.Publish(Snapshot{Environment: "old", UpdatedAt: current.UpdatedAt.Add(-time.Second)})
	got, ready := cache.Latest()
	if !ready || got.Environment != "current" {
		t.Fatal("older collection replaced current snapshot")
	}
	newer := Snapshot{Environment: "new", UpdatedAt: current.UpdatedAt.Add(time.Second), Apps: []Result{}}
	cache.Publish(newer)
	got, _ = cache.Latest()
	if got.Environment != "new" {
		t.Fatal("new collection was not published")
	}
	if _, ready := (&Cache{}).Latest(); ready {
		t.Fatal("snapshots must not persist across processes")
	}
}

func TestConcurrentReadersSeeCompleteSnapshots(t *testing.T) {
	cache := &Cache{}
	var wg sync.WaitGroup
	for worker := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 100 {
				name := fmt.Sprintf("%d-%d", worker, i)
				cache.Publish(Snapshot{Environment: name, UpdatedAt: time.Now(), Apps: []Result{{App: App{Name: name}}}})
				got, ready := cache.Latest()
				if !ready || len(got.Apps) != 1 || got.Environment != got.Apps[0].Name {
					t.Error("reader saw a partial snapshot")
				}
			}
		}()
	}
	wg.Wait()
}
