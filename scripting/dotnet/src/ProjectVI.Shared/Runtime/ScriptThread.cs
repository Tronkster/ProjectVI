using System.Collections.Concurrent;

namespace ProjectVI.Runtime;

/// <summary>
/// The one thread all script code runs on. Its SynchronizationContext brings every <c>await</c>
/// back to this thread, so scripts never race each other and never need locks.
/// </summary>
internal sealed class ScriptThread : IDisposable
{
    private readonly BlockingCollection<(SendOrPostCallback Callback, object? State)> queue = [];
    private readonly Thread thread;
    private readonly Action<Exception> onUnhandled;

    public ScriptThread(Action<Exception> onUnhandled)
    {
        this.onUnhandled = onUnhandled;
        Context = new ScriptSynchronizationContext(this);
        thread = new Thread(Run) { IsBackground = true, Name = "ProjectVI scripts" };
        thread.Start();
    }

    public SynchronizationContext Context { get; }

    public bool IsCurrent => Thread.CurrentThread == thread;

    /// <summary>Work items waiting to run. Lets ProjectVI.Testing wait until scripts are idle.</summary>
    public int QueueLength => queue.Count;

    public void Post(SendOrPostCallback callback, object? state)
    {
        if (!queue.IsAddingCompleted)
        {
            queue.Add((callback, state));
        }
    }

    public void Post(Action action) => Post(_ => action(), null);

    /// <summary>Runs async work on the script thread and returns its result to the caller's thread.</summary>
    public Task<T> InvokeAsync<T>(Func<Task<T>> work)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(async () =>
        {
            try
            {
                tcs.SetResult(await work());
            }
            catch (Exception ex)
            {
                tcs.SetException(ex);
            }
        });
        return tcs.Task;
    }

    private void Run()
    {
        SynchronizationContext.SetSynchronizationContext(Context);
        foreach (var (callback, state) in queue.GetConsumingEnumerable())
        {
            try
            {
                callback(state);
            }
            catch (Exception ex)
            {
                onUnhandled(ex);
            }
        }
    }

    public void Dispose()
    {
        queue.CompleteAdding();
        thread.Join(TimeSpan.FromSeconds(5));
    }

    private sealed class ScriptSynchronizationContext(ScriptThread owner) : SynchronizationContext
    {
        public override void Post(SendOrPostCallback d, object? state) => owner.Post(d, state);

        public override void Send(SendOrPostCallback d, object? state)
        {
            if (owner.IsCurrent)
            {
                d(state);
                return;
            }
            using var done = new ManualResetEventSlim();
            Exception? error = null;
            owner.Post(_ =>
            {
                try
                {
                    d(state);
                }
                catch (Exception ex)
                {
                    error = ex;
                }
                finally
                {
                    done.Set();
                }
            }, null);
            done.Wait();
            if (error is not null)
            {
                throw error;
            }
        }

        public override SynchronizationContext CreateCopy() => this;
    }
}
