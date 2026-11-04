import { useRef, useState } from 'react';
import { Alert, Button, Dialog, DialogTrigger, TextField } from '@mucsi96/react-ui';
import { z } from 'zod';
import { ExternalLink } from '../../../components/ExternalLink';
import styles from './AddIssue.module.css';

const createdIssue = z.object({ number: z.number().int().positive(), url: z.url() });

export function AddIssue({ name, repository }: { name: string; repository: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<z.infer<typeof createdIssue> | null>(null);

  function changeOpen(value: boolean) {
    if (submitting.current) return;
    setOpen(value);
    if (value) {
      setTitle('');
      setDescription('');
      setError('');
      setCreated(null);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !title.trim() || created) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Observatory-Request': 'create-issue' },
        body: JSON.stringify({ repository, title: title.trim(), description }),
        signal: AbortSignal.timeout(25_000),
      });
      if (response.status === 401)
        throw new Error('Your session expired. Reload and sign in to Observatory again.');
      if (response.status === 403)
        throw new Error(
          'Issue creation requires the createIssues role. Ask your Observatory administrator for access.',
        );
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error(
          'Could not confirm issue creation. Check your session and the repository before trying again.',
        );
      }
      const result: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(result);
        throw new Error(
          failure.success
            ? failure.data.error
            : 'Could not confirm issue creation. Check the repository before trying again.',
        );
      }
      setCreated(createdIssue.parse(result));
    } catch (error) {
      setError(
        error instanceof Error && error.name === 'Error'
          ? error.message
          : 'Could not confirm issue creation. Check the repository before trying again to avoid a duplicate.',
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <DialogTrigger isOpen={open} onOpenChange={changeOpen}>
      <Button variant="text" className={styles.trigger}>
        Add issue
      </Button>
      <Dialog
        title={`Add issue for ${name}`}
        description={repository}
        isDismissable={!pending}
        isKeyboardDismissDisabled={pending}
      >
        {created ? (
          <div className={styles.form}>
            <Alert tone="success">
              Issue #{created.number} created. Counts update after the next collection.
            </Alert>
            <ExternalLink href={created.url}>View issue #{created.number} ↗</ExternalLink>
            <Button onPress={() => changeOpen(false)}>Done</Button>
          </div>
        ) : (
          <form onSubmit={submit} className={styles.form}>
            <TextField
              label="Title"
              value={title}
              onChange={setTitle}
              isRequired
              maxLength={256}
              autoFocus
              isDisabled={pending}
            />
            <TextField
              label="Description"
              value={description}
              onChange={setDescription}
              multiline
              rows={6}
              isDisabled={pending}
            />
            {error && <Alert tone="error">{error}</Alert>}
            <div className={styles.actions}>
              <Button variant="text" onPress={() => changeOpen(false)} isDisabled={pending}>
                Cancel
              </Button>
              <Button type="submit" isDisabled={pending || !title.trim()}>
                {pending ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </DialogTrigger>
  );
}
