import * as rs from './reactivestreams-spec';
import * as flow from './flow';

/** Class representing a cancelled subscription that ignores Subscription calls. */
class CancelledSubscription implements rs.Subscription {
    request(n: number) : void {
        // deliberately ignored
    }
    
    cancel() : void {
        // deliberately ignored
    }
}

/** A subscription that does not react to any Subscription calls and appears to be empty. */
export class EmptySubscription implements flow.QueueSubscription<any> {
    request(n: number) : void {
        // deliberately ignored
    }
    
    cancel() : void {
        // deliberately ignored
    }
    
    requestFusion(mode : number) : number {
        return flow.FC.NONE;
    }
    
    offer(t: any) : boolean {
        throw new Error("Unsupported in Fusion mode");
    }
    
    poll() : any {
        return null;
    }
    
    isEmpty() : boolean {
        return true;
    }
    
    size() : number {
        return 0;
    }
    
    clear() : void {
        // no op
    }
    
    /** Set the singleton empty instance on the target subscriber and complete it. */
    static complete(s : rs.Subscriber<any>) : void {
        s.onSubscribe(EmptySubscription.INSTANCE);
        s.onComplete();
    }
    
    /** Set the singleton empty instance on the target and call onError on it. */
    static error(s : rs.Subscriber<any>, e : Error) : void {
        s.onSubscribe(EmptySubscription.INSTANCE);
        s.onError(e);
    }
    
    private static EMPTY_INSTANCE = new EmptySubscription();
    
    /** Returns the singleton instance of this class. */
    public static get INSTANCE() : rs.Subscription { return EmptySubscription.EMPTY_INSTANCE };
}

/** Emits a constant value once there is a request for it. */
export class ScalarSubscription<T> implements flow.QueueSubscription<T> {
    private mActual : rs.Subscriber<T>;
    private mValue : T;
    private once : boolean;
    
    constructor(value: T, actual: rs.Subscriber<T>) {
        this.mValue = value;
        this.mActual = actual;
    }
    
    request(n : number) {
        if (SH.validRequest(n)) {
            if (!this.once) {
                this.once = true;
                
                this.mActual.onNext(this.mValue);
                this.mActual.onComplete();
            }
        }
    }
    
    cancel() {
        this.once = true;
    }
    
    offer(t: T) : boolean {
        throw flow.FC.unsupported();
    }
    
    poll() : T {
        if (!this.once) {
            this.once = true;
            return this.mValue;
        }
        return null;
    }
    
    isEmpty() : boolean {
        return this.once;
    }
    
    clear() {
        this.once = true;
    }
    
    size() : number {
        return this.once ? 0 : 1;
    }
    
    requestFusion(mode: number) : number {
        if ((mode & flow.FC.SYNC) != 0) {
            return flow.FC.SYNC;
        }
        return flow.FC.NONE;
    }
}

enum DeferredState {
    NO_REQUEST_NO_VALUE,
    HAS_REQUEST_NO_VALUE,
    NO_REQUEST_HAS_VALUE,
    HAS_REQUEST_HAS_VALUE,
    CANCELLED,
}

enum FusedState {
    NOT_FUSED,
    NO_VALUE,
    HAS_VALUE,
    COMPLETE
}

/** A fuseable Subscription that holds a single value and emits it when there is request for it. */
export class DeferrendScalarSubscription<T> implements flow.QueueSubscription<T> {
    protected mActual: rs.Subscriber<T>;
    private mValue: T;
    private mState: DeferredState;
    private mFused: FusedState;
    
    constructor(actual: rs.Subscriber<T>) {
        this.mActual = actual;
        this.mState = DeferredState.NO_REQUEST_NO_VALUE;
        this.mFused = FusedState.NOT_FUSED;
    }
    
    public complete(t: T) {
        if (this.mFused == FusedState.NO_VALUE) {
            this.mValue = t;
            this.mFused = FusedState.HAS_VALUE;
            
            this.mActual.onNext(t);
            this.mActual.onComplete();            
        } else {
            const s = this.mState;
            if (s == DeferredState.HAS_REQUEST_NO_VALUE) {
                this.mState = DeferredState.HAS_REQUEST_HAS_VALUE;
                
                this.mActual.onNext(t);
                if (this.mState != DeferredState.CANCELLED) {
                    this.mActual.onComplete();
                }
            } else
            if (s == DeferredState.NO_REQUEST_NO_VALUE) {
                this.mValue = t;
                this.mState = DeferredState.NO_REQUEST_HAS_VALUE;
            }
        }
    }
    
    request(n: number) : void {
        if (SH.validRequest(n)) {
            const s = this.mState;
            if (s == DeferredState.NO_REQUEST_HAS_VALUE) {
                this.mState = DeferredState.HAS_REQUEST_HAS_VALUE;

                this.mActual.onNext(this.mValue);
                if (this.mState != DeferredState.CANCELLED) {
                    this.mActual.onComplete();
                }
            } else
            if (s == DeferredState.NO_REQUEST_NO_VALUE) {
                this.mState = DeferredState.HAS_REQUEST_NO_VALUE;
            }
        }
    }
    
    cancel() : void {
        this.mState = DeferredState.CANCELLED;
        this.mFused = FusedState.COMPLETE;
    }
    
    requestFusion(mode: number) : number {
        if ((mode & flow.FC.ASYNC) != 0 && (mode & flow.FC.BOUNDARY) == 0) {
            this.mFused = FusedState.NO_VALUE;
            return flow.FC.ASYNC;
        }
        return flow.FC.NONE;
    }
    
    offer(t: T) : boolean {
        throw flow.FC.unsupported();
    }
    
    poll() : T {
        if (this.mFused == FusedState.HAS_VALUE) {
            this.mFused = FusedState.COMPLETE;
            return this.mValue;
        }
        return null;
    }
    
    isEmpty() : boolean {
        return this.mFused != FusedState.HAS_VALUE;
    }
    
    size() : number {
        return this.isEmpty() ? 0 : 1;
    }
    
    clear() : void {
        this.mFused = FusedState.COMPLETE;
    }
}

/** Suppresses the fusion capability of an upstream source. */
export class SuppressFusionSubscriber<T> implements rs.Subscriber<T>, flow.QueueSubscription<T> {
    private mActual : rs.Subscriber<T>;
    
    private s: rs.Subscription;
    
    constructor(actual: rs.Subscriber<T>) {
        this.mActual = actual;
    }
    
    onSubscribe(s: rs.Subscription) {
        this.s = s;
        this.mActual.onSubscribe(this);
    }
    
    onNext(t: T) {
        this.mActual.onNext(t);
    }
    
    onError(t: Error) {
        this.mActual.onError(t);
    }
    
    onComplete() {
        this.mActual.onComplete();
    }

    request(n: number) {
        this.s.request(n);
    }
    
    cancel() {
        this.s.cancel();
    }

    requestFusion(mode: number) : number {
        return flow.FC.NONE;
    }
    
    offer(t: T) : boolean {
        throw flow.FC.unsupported();
    }
    
    poll() : T {
        return null;
    }
    
    isEmpty() : boolean {
        return true;
    }
    
    size() : number {
        return 0;
    }
    
    clear() : void {
        // deliberately no op
    }
    
}

/** Utility methods to validate requests and Subscription status. */
export class SH {
    /** Verify that the number is positive. */
    static validRequest(n: number) : boolean {
        if (n <= 0) {
            throw new Error("n > 0 required but it was " + n);
        }
        return true;
    }
    
    /** Verify that the current Subscription is null and the new Subscription is not null, otherwise
     * cancel the incoming subscription and throw an error. */
    static validSubscription(current: rs.Subscription, s: rs.Subscription) : boolean {
        if (s == null) {
            throw new Error("s is null");
        }
        if (current != null) {
            s.cancel();
            if (current != SH.CANCELLED) {
                throw new Error("Subscription already set!");
            }
            return false;
        }
        return true;
    }
    
    private static CANCELLED_INSTANCE = new CancelledSubscription();
    
    /** The standard cancelled Subscription instance. */
    static get CANCELLED() : rs.Subscription { return SH.CANCELLED_INSTANCE; };
    
    private static TERMINAL_ERROR_INSTANCE = new Error("Terminated");

    /** The standard exception indicating no more exception can be accumulated. */
    static get TERMINAL_ERROR() : Error { return SH.TERMINAL_ERROR_INSTANCE; }
}
