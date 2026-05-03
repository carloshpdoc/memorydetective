/**
 * Per-pattern fix templates: Swift code snippets showing the typical
 * before/after for each cycle pattern in the catalog. Pairs with
 * `staticAnalysisHints.ts` and `classifyCycle.PATTERNS` to give the
 * agent a concrete code example it can adapt to the user's context.
 *
 * Templates are deliberately minimal — just enough to demonstrate the
 * shape of the fix. The agent fills in real type/method names from the
 * surrounding code via the SourceKit-LSP tools.
 */

export interface FixTemplate {
  /** Optional one-line description if the snippet alone needs framing. */
  context?: string;
  /** Code that shows the leak shape. */
  before: string;
  /** Code that fixes it. */
  after: string;
  /**
   * Optional notes — e.g. "this only works on iOS 14+" or
   * "the WeakProxy class is a one-time helper you add to your codebase".
   */
  notes?: string;
}

/**
 * Pattern-id → fix template. Every pattern in `classifyCycle.PATTERNS`
 * has an entry. Coverage is enforced by a 1:1 test guard.
 */
const TEMPLATES: Record<string, FixTemplate> = {
  // ─────────────────────────────────────────────────────────────────────────
  // v1.0 core
  // ─────────────────────────────────────────────────────────────────────────

  "swiftui.tag-index-projection": {
    context: "SwiftUI ForEach + .tag() with self-capturing closure",
    before: `ForEach(items) { item in
    Cell(item: item)
        .onTapGesture {
            self.viewModel.handleTap(item)
        }
        .tag(item.id)
}`,
    after: `ForEach(items) { item in
    Cell(item: item)
        .onTapGesture { [weak vm = self.viewModel] in
            vm?.handleTap(item)
        }
        .tag(item.id)
}`,
    notes:
      "If the closure captures multiple things from self, weak-capture each one explicitly. Avoid `[weak self]` because TagIndexProjection often needs the references resolved synchronously.",
  },
  "swiftui.dictstorage-weakbox-cycle": {
    context:
      "SwiftUI internal observation cycle. Find your app-level types in the chain and break the strong capture there.",
    before: `// Look up the chain in the memgraph for your app-level types.
// The cycle root is _DictionaryStorage<...WeakBox<AnyLocationBase>>;
// the user-fixable side is whatever closure captures self below it.
class MyViewModel: ObservableObject {
    @Published var items: [Item] = []
    func bind() {
        SomePublisher.assign(to: \\.items, on: self) // ⚠️ retains self
    }
}`,
    after: `class MyViewModel: ObservableObject {
    @Published var items: [Item] = []
    func bind() {
        SomePublisher.assign(to: &$items) // OK — auto-cancels with @Published
    }
}`,
  },
  "swiftui.foreach-state-tap": {
    before: `ForEach(items) { item in
    Cell(item: item)
        .onTapGesture {
            self.handleTap(item) // captures self strongly
        }
}`,
    after: `ForEach(items) { item in
    Cell(item: item)
        .onTapGesture { [weak self] in
            self?.handleTap(item)
        }
}`,
    notes:
      "Or make handleTap a static helper that takes the dependencies as parameters.",
  },
  "closure.viewmodel-wrapped-strong": {
    context:
      "Closure captures `_viewModel.wrappedValue` strongly via the property wrapper.",
    before: `struct MyView: View {
    @StateObject var viewModel: MyViewModel
    var body: some View {
        Button("Tap") {
            self._viewModel.wrappedValue.handleTap() // strong capture
        }
    }
}`,
    after: `struct MyView: View {
    @StateObject var viewModel: MyViewModel
    var body: some View {
        Button("Tap") { [weak vm = _viewModel.wrappedValue] in
            vm?.handleTap()
        }
    }
}`,
  },
  "viewcontroller.uinavigationcontroller-host": {
    context:
      "UIViewControllerRepresentable wrapping a UINavigationController. Clear the stack on dismantle.",
    before: `struct NavWrapper: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UINavigationController {
        UINavigationController(rootViewController: UIHostingController(rootView: ChildView()))
    }
    func updateUIViewController(_: UINavigationController, context: Context) {}
    // ⚠️ no dismantleUIViewController — the host->VC->host cycle stays alive
}`,
    after: `struct NavWrapper: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UINavigationController {
        UINavigationController(rootViewController: UIHostingController(rootView: ChildView()))
    }
    func updateUIViewController(_: UINavigationController, context: Context) {}
    static func dismantleUIViewController(_ uiVC: UINavigationController, coordinator: ()) {
        uiVC.viewControllers = [] // breaks the cycle
    }
}`,
  },
  "combine.sink-store-self-capture": {
    before: `class VM: ObservableObject {
    @Published var value = 0
    private var bag = Set<AnyCancellable>()
    func observe(_ pub: AnyPublisher<Int, Never>) {
        pub.sink { v in self.value = v }.store(in: &bag) // ⚠️ retains self
    }
}`,
    after: `class VM: ObservableObject {
    @Published var value = 0
    private var bag = Set<AnyCancellable>()
    func observe(_ pub: AnyPublisher<Int, Never>) {
        pub.sink { [weak self] v in self?.value = v }.store(in: &bag)
        // OR for property-path: pub.assign(to: &$value)
    }
}`,
  },
  "concurrency.task-without-weak-self": {
    before: `class VM {
    func startWatching() {
        Task {
            for await event in stream {
                self.handle(event) // strong capture for task lifetime
            }
        }
    }
}`,
    after: `class VM {
    private var task: Task<Void, Never>?
    func startWatching() {
        task = Task { [weak self] in
            for await event in stream {
                guard let self else { break }
                self.handle(event)
            }
        }
    }
    deinit { task?.cancel() }
}`,
  },
  "notificationcenter.observer-strong": {
    before: `class VC: UIViewController {
    var token: NSObjectProtocol?
    override func viewDidLoad() {
        token = NotificationCenter.default.addObserver(
            forName: .someNotif, object: nil, queue: .main
        ) { _ in
            self.refresh() // strong capture
        }
    }
}`,
    after: `class VC: UIViewController {
    var token: NSObjectProtocol?
    override func viewDidLoad() {
        token = NotificationCenter.default.addObserver(
            forName: .someNotif, object: nil, queue: .main
        ) { [weak self] _ in
            self?.refresh()
        }
    }
    deinit {
        if let token { NotificationCenter.default.removeObserver(token) }
    }
}`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // v1.4 expansion
  // ─────────────────────────────────────────────────────────────────────────

  "timer.scheduled-target-strong": {
    before: `class VC {
    var timer: Timer?
    func start() {
        timer = Timer.scheduledTimer(timeInterval: 1, target: self,
            selector: #selector(tick), userInfo: nil, repeats: true)
    }
    @objc func tick() { /* ... */ }
}`,
    after: `class VC {
    var timer: Timer?
    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }
    @objc func tick() { /* ... */ }
    deinit { timer?.invalidate() }
}`,
  },
  "displaylink.target-strong": {
    before: `class Renderer {
    var link: CADisplayLink?
    func start() {
        link = CADisplayLink(target: self, selector: #selector(step))
        link?.add(to: .main, forMode: .common)
    }
    @objc func step(_ link: CADisplayLink) { /* ... */ }
}`,
    after: `final class WeakProxy<T: AnyObject>: NSObject {
    weak var target: T?
    init(_ target: T) { self.target = target }
}

class Renderer {
    var link: CADisplayLink?
    private var proxy: WeakProxy<Renderer>?
    func start() {
        proxy = WeakProxy(self)
        link = CADisplayLink(target: proxy!, selector: #selector(WeakProxy<Renderer>.forward(_:)))
        link?.add(to: .main, forMode: .common)
    }
    @objc func step(_ link: CADisplayLink) { /* ... */ }
    deinit { link?.invalidate() }
}`,
    notes: "WeakProxy is a one-time helper you can put in a Utilities folder.",
  },
  "gesture.target-strong": {
    before: `class VC: UIViewController {
    override func viewDidLoad() {
        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap))
        view.addGestureRecognizer(tap)
    }
    @objc func onTap() { /* ... */ }
}`,
    after: `class VC: UIViewController {
    override func viewDidLoad() {
        // iOS 14+: closure-style action, UIKit handles weakly
        let tap = UITapGestureRecognizer(target: nil, action: nil)
        tap.addAction(UIAction { [weak self] _ in self?.onTap() })
        view.addGestureRecognizer(tap)
    }
    func onTap() { /* ... */ }
}`,
    notes:
      "Or for selector-form: `tap.removeTarget(self, action: nil)` in `deinit`.",
  },
  "kvo.observation-not-invalidated": {
    before: `class VM {
    var token: NSKeyValueObservation?
    func bind(to obj: SomeKVOClass) {
        token = obj.observe(\\.value) { _, _ in
            self.refresh() // strong capture
        }
    }
}`,
    after: `class VM {
    var token: NSKeyValueObservation?
    func bind(to obj: SomeKVOClass) {
        token = obj.observe(\\.value) { [weak self] _, _ in
            self?.refresh()
        }
    }
    deinit { token?.invalidate() }
}`,
  },
  "urlsession.delegate-strong": {
    before: `class APIClient: NSObject, URLSessionDelegate {
    let session: URLSession
    override init() {
        super.init()
        // ⚠️ session retains self as delegate; APIClient never deallocs
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }
}`,
    after: `class APIClient: NSObject, URLSessionDelegate {
    let session: URLSession
    override init() {
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }
    deinit {
        session.invalidateAndCancel() // breaks the strong-delegate retain
    }
}`,
  },
  "dispatch.source-event-handler-self": {
    before: `class FileWatcher {
    let source: DispatchSourceFileSystemObject
    init(fd: Int32) {
        source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write)
        source.setEventHandler {
            self.handle() // strong capture
        }
        source.resume()
    }
}`,
    after: `class FileWatcher {
    let source: DispatchSourceFileSystemObject
    init(fd: Int32) {
        source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write)
        source.setEventHandler { [weak self] in
            self?.handle()
        }
        source.resume()
    }
    deinit {
        source.setEventHandler {} // clear the closure
        source.cancel()
    }
}`,
  },
  "notificationcenter.observer-not-removed": {
    before: `class VC: UIViewController {
    var token: NSObjectProtocol?
    override func viewDidLoad() {
        token = NotificationCenter.default.addObserver(
            forName: .someNotif, object: nil, queue: .main
        ) { [weak self] _ in self?.refresh() }
        // ⚠️ no removeObserver in deinit — observer stays in NotificationCenter forever
    }
}`,
    after: `class VC: UIViewController {
    var token: NSObjectProtocol?
    override func viewDidLoad() {
        token = NotificationCenter.default.addObserver(
            forName: .someNotif, object: nil, queue: .main
        ) { [weak self] _ in self?.refresh() }
    }
    deinit {
        if let token { NotificationCenter.default.removeObserver(token) }
    }
}`,
  },
  "delegate.strong-reference": {
    before: `protocol MyServiceDelegate: AnyObject { /* ... */ }
class MyService {
    var delegate: MyServiceDelegate? // no \`weak\` modifier
}`,
    after: `protocol MyServiceDelegate: AnyObject { /* ... */ }
class MyService {
    weak var delegate: MyServiceDelegate?
}`,
  },
  "swiftui.envobject-back-reference": {
    before: `class AppViewModel: ObservableObject {
    var hostingController: UIHostingController<RootView>? // ⚠️ strong UIKit ref
}`,
    after: `class AppViewModel: ObservableObject {
    weak var hostingController: UIHostingController<RootView>?
}`,
    notes:
      "If the bridge has to be strong, refactor: pass the controller into the few methods that need it instead of storing it.",
  },
  "combine.assign-to-self": {
    before: `class VM: ObservableObject {
    @Published var x = 0
    var bag = Set<AnyCancellable>()
    func observe(_ pub: AnyPublisher<Int, Never>) {
        pub.assign(to: \\.x, on: self).store(in: &bag) // ⚠️ retains self
    }
}`,
    after: `class VM: ObservableObject {
    @Published var x = 0
    func observe(_ pub: AnyPublisher<Int, Never>) {
        pub.assign(to: &$x) // auto-cancels with @Published
    }
}`,
  },
  "concurrency.task-mainactor-view": {
    before: `struct MyView: View {
    @StateObject var viewModel: VM
    var body: some View {
        Text(viewModel.label)
            .onAppear {
                Task { await self.viewModel.refresh() } // pins view storage
            }
    }
}`,
    after: `struct MyView: View {
    @StateObject var viewModel: VM
    var body: some View {
        Text(viewModel.label)
            .task { // auto-cancelled when the view leaves
                await viewModel.refresh()
            }
    }
}`,
  },
  "concurrency.asyncstream-continuation-self": {
    before: `class Producer {
    private var task: Task<Void, Never>?
    let stream: AsyncStream<Event>
    init() {
        stream = AsyncStream { continuation in
            // ⚠️ continuation captures producer; producer captures stream
            self.subscribe { event in continuation.yield(event) }
        }
    }
}`,
    after: `class Producer {
    private var task: Task<Void, Never>?
    let stream: AsyncStream<Event>
    init() {
        stream = AsyncStream { [weak self] continuation in
            self?.subscribe { event in continuation.yield(event) }
            continuation.onTermination = { [weak self] _ in self?.unsubscribe() }
        }
    }
    deinit { task?.cancel() }
}`,
  },
  "webkit.scriptmessage-handler-strong": {
    before: `class WebVC: UIViewController, WKScriptMessageHandler {
    var webView: WKWebView!
    override func viewDidLoad() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "bridge") // ⚠️ retains self
        webView = WKWebView(frame: view.bounds, configuration: cfg)
        view.addSubview(webView)
    }
    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) { /* */ }
}`,
    after: `class WebVC: UIViewController, WKScriptMessageHandler {
    var webView: WKWebView!
    override func viewDidLoad() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "bridge")
        webView = WKWebView(frame: view.bounds, configuration: cfg)
        view.addSubview(webView)
    }
    deinit {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
    }
    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) { /* */ }
}`,
    notes:
      "Or use a WeakScriptMessageHandler proxy class — see the v1.6 webkit.wkscriptmessagehandler-bridge fix template.",
  },
  "coordinator.parent-strong-back-reference": {
    before: `class ChildCoordinator {
    var parentCoordinator: AppCoordinator? // ⚠️ no \`weak\`
}
class AppCoordinator {
    var childCoordinators: [ChildCoordinator] = []
}`,
    after: `class ChildCoordinator {
    weak var parentCoordinator: AppCoordinator?
}
class AppCoordinator {
    var childCoordinators: [ChildCoordinator] = []
    func childDidFinish(_ child: ChildCoordinator) {
        childCoordinators.removeAll { $0 === child }
    }
}`,
  },
  "rxswift.disposebag-self-cycle": {
    before: `class VM {
    let bag = DisposeBag()
    func observe(_ obs: Observable<Int>) {
        obs.subscribe(onNext: self.handle).disposed(by: bag) // ⚠️ unbound method ref
    }
    func handle(_ value: Int) { /* */ }
}`,
    after: `class VM {
    let bag = DisposeBag()
    func observe(_ obs: Observable<Int>) {
        obs.subscribe(onNext: { [weak self] v in self?.handle(v) }).disposed(by: bag)
    }
    func handle(_ value: Int) { /* */ }
}`,
  },
  "realm.notificationtoken-retained": {
    before: `class VM {
    var token: NotificationToken?
    func observe(_ results: Results<Item>) {
        token = results.observe { _ in
            self.refresh() // strong capture
        }
    }
}`,
    after: `class VM {
    var token: NotificationToken?
    func observe(_ results: Results<Item>) {
        token = results.observe { [weak self] _ in
            self?.refresh()
        }
    }
    deinit { token?.invalidate() }
}`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // v1.5 catalog completion
  // ─────────────────────────────────────────────────────────────────────────

  "coreanimation.animation-delegate-strong": {
    before: `class FadeView: UIView, CAAnimationDelegate {
    func fadeOut() {
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.delegate = self // ⚠️ CAAnimation.delegate is STRONG (Apple-documented)
        anim.toValue = 0
        layer.add(anim, forKey: "fade")
    }
    func animationDidStop(_ anim: CAAnimation, finished: Bool) { /* */ }
}`,
    after: `class FadeView: UIView, CAAnimationDelegate {
    func fadeOut() {
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.delegate = self
        anim.toValue = 0
        layer.add(anim, forKey: "fade")
    }
    func animationDidStop(_ anim: CAAnimation, finished: Bool) {
        anim.delegate = nil // breaks the strong cycle when animation ends
    }
}`,
    notes:
      "Or wrap in a value-type AnimationProxyDelegate that holds the real owner weakly.",
  },
  "coreanimation.layer-delegate-cycle": {
    before: `class CustomRenderer { // NOT a UIView
    let shapeLayer = CAShapeLayer()
    init() {
        shapeLayer.delegate = self // ⚠️ CALayer.delegate retain pattern
    }
}`,
    after: `final class WeakLayerDelegate: NSObject, CALayerDelegate {
    weak var owner: CustomRenderer?
}

class CustomRenderer {
    let shapeLayer = CAShapeLayer()
    private let proxy = WeakLayerDelegate()
    init() {
        proxy.owner = self
        shapeLayer.delegate = proxy
    }
    deinit { shapeLayer.delegate = nil }
}`,
  },
  "coredata.fetchedresultscontroller-delegate": {
    before: `class ListVC: UIViewController, NSFetchedResultsControllerDelegate {
    let frc: NSFetchedResultsController<Item>
    init(...) {
        frc = NSFetchedResultsController(...)
        super.init(...)
        frc.delegate = self // ⚠️ change-tracker retains self
    }
}`,
    after: `class ListVC: UIViewController, NSFetchedResultsControllerDelegate {
    let frc: NSFetchedResultsController<Item>
    init(...) {
        frc = NSFetchedResultsController(...)
        super.init(...)
        frc.delegate = self
    }
    deinit {
        frc.delegate = nil // explicitly clear before VC dies
    }
}`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // v1.6 catalog
  // ─────────────────────────────────────────────────────────────────────────

  "swiftui.observable-state-modal-leak": {
    before: `@Observable class ItemModel {
    var name = ""
}

struct ParentView: View {
    @State private var showSheet = false
    var body: some View {
        Button("Open") { showSheet = true }
            .sheet(isPresented: $showSheet) {
                // ⚠️ creates a new @State per sheet presentation; older instances leak
                ChildView(model: ItemModel())
            }
    }
}

struct ChildView: View {
    @State var model: ItemModel
    var body: some View { TextField("Name", text: $model.name) }
}`,
    after: `@Observable class ItemModel {
    var name = ""
}

struct ParentView: View {
    @State private var model = ItemModel() // owned by parent, lifetime stable
    @State private var showSheet = false
    var body: some View {
        Button("Open") { showSheet = true }
            .sheet(isPresented: $showSheet) {
                ChildView(model: model) // pass, don't allocate
            }
    }
}

struct ChildView: View {
    @Bindable var model: ItemModel // @Bindable, not @State
    var body: some View { TextField("Name", text: $model.name) }
}`,
  },
  "swiftui.navigationpath-stored-in-viewmodel": {
    before: `@Observable class Router {
    var path = NavigationPath() // ⚠️ retains every element ever pushed
    func push<V: Hashable>(_ destination: V) { path.append(destination) }
}`,
    after: `// Option 1: keep path local to the view
struct ContentView: View {
    @State private var path = NavigationPath()
    var body: some View {
        NavigationStack(path: $path) { /* ... */ }
    }
}

// Option 2: when path MUST persist on a router, reset after popToRoot
@Observable class Router {
    var path = NavigationPath()
    func popToRoot() {
        path = NavigationPath() // discard accumulated retention
    }
}`,
  },
  "concurrency.async-sequence-on-self": {
    before: `class Watcher {
    private var task: Task<Void, Never>?
    func start(_ stream: AsyncStream<Event>) {
        task = Task {
            for await event in stream {
                self.handle(event) // ⚠️ iteration holds self via actor isolation
            }
        }
    }
}`,
    after: `class Watcher {
    private var task: Task<Void, Never>?
    func start(_ stream: AsyncStream<Event>) {
        task = Task { [weak self] in
            for await event in stream {
                guard let me = self else { break }
                me.handle(event)
            }
        }
    }
    deinit { task?.cancel() }
}`,
    notes:
      "The `[weak self]` on the Task is necessary but NOT sufficient on infinite streams — you also need explicit `task.cancel()` in deinit.",
  },
  "concurrency.notificationcenter-async-observer-task": {
    before: `class Listener {
    private var task: Task<Void, Never>?
    init() {
        task = Task {
            // ⚠️ never terminates → never cancels → pins self forever
            for await note in NotificationCenter.default.notifications(named: .myNotif) {
                self.handle(note)
            }
        }
    }
}`,
    after: `class Listener {
    private var task: Task<Void, Never>?
    init() {
        task = Task { [weak self] in
            for await note in NotificationCenter.default.notifications(named: .myNotif) {
                guard let self else { break }
                self.handle(note)
            }
        }
    }
    deinit { task?.cancel() }
}`,
  },
  "swiftui.observations-closure-strong-self": {
    before: `class WatcherVM {
    let model = MyObservableModel()
    init() {
        Observations { [model] in
            self.refresh(value: model.value) // ⚠️ closure retains self
        }
    }
    func refresh(value: Int) { /* */ }
}`,
    after: `class WatcherVM {
    let model = MyObservableModel()
    init() {
        Observations { [model, weak self] in
            self?.refresh(value: model.value)
        }
    }
    func refresh(value: Int) { /* */ }
}`,
  },
  "webkit.wkscriptmessagehandler-bridge": {
    before: `class WebBridge: NSObject, WKScriptMessageHandler {
    var webView: WKWebView!
    override init() {
        super.init()
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "native") // ⚠️ 3-link cycle
        webView = WKWebView(frame: .zero, configuration: cfg)
    }
    func userContentController(_: WKUserContentController, didReceive: WKScriptMessage) { /* */ }
}`,
    after: `final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var realHandler: WKScriptMessageHandler?
    init(_ handler: WKScriptMessageHandler) { self.realHandler = handler }
    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) {
        realHandler?.userContentController(ucc, didReceive: m)
    }
}

class WebBridge: NSObject, WKScriptMessageHandler {
    var webView: WKWebView!
    private let weakHandler: WeakScriptMessageHandler
    override init() {
        weakHandler = WeakScriptMessageHandler({} as WKScriptMessageHandler) // placeholder, set below
        super.init()
        weakHandler.realHandler = self
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(weakHandler, name: "native") // controller retains the proxy, not self
        webView = WKWebView(frame: .zero, configuration: cfg)
    }
    func userContentController(_: WKUserContentController, didReceive: WKScriptMessage) { /* */ }
}`,
    notes:
      "Yes, this is verbose. WeakScriptMessageHandler is a one-time helper that pays for itself across every WKWebView bridge in the app.",
  },

  // ─────────────────────────────────────────────────────────────────────────
  // v1.7 catalog
  // ─────────────────────────────────────────────────────────────────────────

  "swiftdata.modelcontext-actor-cycle": {
    before: `actor DataLayer {
    let context: ModelContext
    private let executor: DefaultSerialModelExecutor
    init(container: ModelContainer) {
        context = ModelContext(container)
        executor = DefaultSerialModelExecutor(modelContext: context) // ⚠️ cycle
    }
}`,
    after: `// Prefer the @ModelActor macro (iOS 17+) — handles the executor wiring safely
@ModelActor
actor DataLayer {
    func fetchItems() throws -> [Item] {
        try modelContext.fetch(FetchDescriptor<Item>())
    }
}

// If you must roll your own, hold ModelContext weakly inside the executor and
// re-resolve per operation:
final class WeakContextExecutor {
    weak var context: ModelContext?
    init(_ context: ModelContext) { self.context = context }
}`,
    notes:
      "Apple fixed the framework-level shape in iOS 18 beta 1 (FB13844786). When your minimum target is iOS 18+, the @ModelActor-generated executor is safe.",
  },
};

/** Returns the fix template for a given pattern, or null if unknown. */
export function getFixTemplate(patternId: string): FixTemplate | null {
  return TEMPLATES[patternId] ?? null;
}

/** All known pattern ids that have templates. Used in tests for coverage assertion. */
export function knownTemplatePatternIds(): string[] {
  return Object.keys(TEMPLATES);
}
