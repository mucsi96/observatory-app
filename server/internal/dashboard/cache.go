package dashboard

import "sync"

// Cache publishes complete snapshots atomically. Snapshots and their nested
// slices are immutable after publication: the collector creates a new result
// for each poll, and HTTP handlers only read it. A new process starts empty.
type Cache struct {
	mu       sync.RWMutex
	snapshot Snapshot
	ready    bool
}

func (c *Cache) Publish(snapshot Snapshot) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ready && !snapshot.UpdatedAt.After(c.snapshot.UpdatedAt) {
		return
	}
	c.snapshot = snapshot
	c.ready = true
}

func (c *Cache) Latest() (Snapshot, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshot, c.ready
}
