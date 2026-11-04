import { useRef, useState } from 'react';
import { Alert, Button, Dialog, DialogTrigger, TextField } from '@mucsi96/react-ui';
import { useCreateIssue } from '../api';
import { ExternalLink } from '../../../components/ExternalLink';
import styles from './AddIssue.module.css';

export function AddIssue({ name, repository }: { name: string; repository: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const mutation = useCreateIssue();
  const { isPending: pending, error, data: created } = mutation;
  const submitting = useRef(false);

  function changeOpen(value: boolean) {
    if (submitting.current) return;
    setOpen(value);
    if (value) {
      setTitle('');
      setDescription('');
      mutation.reset();
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !title.trim() || created) return;
    submitting.current = true;
    try {
      await mutation.mutateAsync({ repository, title, description });
    } catch {
      // The mutation exposes the error while the local draft remains editable.
    } finally {
      submitting.current = false;
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
            {error && <Alert tone="error">{error.message}</Alert>}
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
