//
//  MCPTestApp — a fixture for exercising this MCP server's UI tools.
//
//  Deliberately tiny, and deliberately shaped around one bug: Apple's AX
//  translation graph has no parent->child edge into the system chrome
//  containers, so a control inside a nav bar or a toolbar is absent from the
//  accessibility tree even though it is on screen, labelled, and tappable.
//  See TODO.md #22 / #34 and the "Root cause" section there.
//
//  So every control comes in a pair: one in the plain view hierarchy, one in
//  chrome. Anything that finds the plain one but not its twin has hit the bug.
//
//  Not shipped with the package — package.json's `files` covers `build` and
//  `companion.lock.json` only.
//

#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>

#pragma mark - Orientation names

// UIKit has two orientation vocabularies and they are deliberately crossed:
// UIOrientation.h defines UIInterfaceOrientationLandscapeLeft as
// UIDeviceOrientationLandscapeRight, "because rotating the device to the left
// requires rotating the content to the right". Reporting both is the only way
// to say which one a tool's own naming agrees with, and the two disagreeing is
// the normal case rather than a fault. They also come apart for a second
// reason: a device can be in an orientation the app does not adopt, which is
// how a notched iPhone answers a request for upside-down portrait.

static NSString *InterfaceOrientationName(UIInterfaceOrientation o) {
  switch (o) {
    case UIInterfaceOrientationPortrait: return @"portrait";
    case UIInterfaceOrientationPortraitUpsideDown: return @"portraitUpsideDown";
    case UIInterfaceOrientationLandscapeLeft: return @"landscapeLeft";
    case UIInterfaceOrientationLandscapeRight: return @"landscapeRight";
    default: return @"unknown";
  }
}

static NSString *DeviceOrientationName(UIDeviceOrientation o) {
  switch (o) {
    case UIDeviceOrientationPortrait: return @"portrait";
    case UIDeviceOrientationPortraitUpsideDown: return @"portraitUpsideDown";
    case UIDeviceOrientationLandscapeLeft: return @"landscapeLeft";
    case UIDeviceOrientationLandscapeRight: return @"landscapeRight";
    case UIDeviceOrientationFaceUp: return @"faceUp";
    case UIDeviceOrientationFaceDown: return @"faceDown";
    default: return @"unknown";
  }
}

#pragma mark - Root view controller

@interface RootViewController : UIViewController <UITextFieldDelegate>
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, strong) UILabel *orientation;
@property(nonatomic, strong) UITextField *plainField;
@property(nonatomic, strong) UITextField *toolbarField;
@end

@implementation RootViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  self.title = @"MCP Test";

  // --- Nav bar: a labelled button inside chrome (TODO.md #34) ---------------
  UIBarButtonItem *navButton =
      [[UIBarButtonItem alloc] initWithTitle:@"Nav Button"
                                       style:UIBarButtonItemStylePlain
                                      target:self
                                      action:@selector(navButtonTapped)];
  navButton.accessibilityIdentifier = @"NavButton";
  self.navigationItem.rightBarButtonItem = navButton;

  // --- Toolbar: the reported case — a button and a text field in the bottom
  // toolbar, the same shape as Contacts' search field (TESTING.md #9) --------
  UIBarButtonItem *toolbarButton =
      [[UIBarButtonItem alloc] initWithTitle:@"Toolbar Button"
                                       style:UIBarButtonItemStylePlain
                                      target:self
                                      action:@selector(toolbarButtonTapped)];
  toolbarButton.accessibilityIdentifier = @"ToolbarButton";

  // No accessibilityLabel on purpose: like Contacts' search field, its visible
  // text lives in AXValue, which is the case `findByLabel`'s value matching
  // exists for (TODO.md #23).
  self.toolbarField = [self fieldWithPlaceholder:@"Toolbar Search"
                                      identifier:@"ToolbarField"];
  self.toolbarField.frame = CGRectMake(0, 0, 200, 32);

  self.toolbarItems = @[
    toolbarButton,
    [UIBarButtonItem flexibleSpaceItem],
    [[UIBarButtonItem alloc] initWithCustomView:self.toolbarField],
  ];

  // --- Plain view hierarchy: the controls that should always be visible -----
  self.plainField = [self fieldWithPlaceholder:@"Type here"
                                    identifier:@"PlainField"];
  self.plainField.accessibilityLabel = @"Plain Field";

  UIButton *plainButton = [UIButton buttonWithType:UIButtonTypeSystem];
  [plainButton setTitle:@"Plain Button" forState:UIControlStateNormal];
  [plainButton addTarget:self
                  action:@selector(plainButtonTapped)
        forControlEvents:UIControlEventTouchUpInside];
  plainButton.accessibilityIdentifier = @"PlainButton";

  // Every action lands here, so a tap or a keystroke can be confirmed from a
  // control that is not itself in chrome — otherwise verifying the toolbar
  // would depend on reading the toolbar.
  self.status = [[UILabel alloc] init];
  self.status.text = @"status: ready";
  self.status.textAlignment = NSTextAlignmentCenter;
  self.status.numberOfLines = 0;
  self.status.accessibilityIdentifier = @"StatusLabel";

  // What the app itself believes, which no tool outside it can observe. It is
  // the only way to check a rotation tool's vocabulary against Apple's, and to
  // tell "the device did not rotate" from "it rotated and the app declined".
  self.orientation = [[UILabel alloc] init];
  self.orientation.textAlignment = NSTextAlignmentCenter;
  self.orientation.numberOfLines = 0;
  self.orientation.font = [UIFont systemFontOfSize:13];
  self.orientation.textColor = UIColor.secondaryLabelColor;
  self.orientation.accessibilityIdentifier = @"OrientationLabel";

  // The device notification fires even when the interface does not follow the
  // device, which is exactly the case worth seeing.
  [UIDevice.currentDevice beginGeneratingDeviceOrientationNotifications];
  [NSNotificationCenter.defaultCenter
      addObserver:self
         selector:@selector(refreshOrientation)
             name:UIDeviceOrientationDidChangeNotification
           object:nil];

  // --- Modals: the two kinds, because they are not the same kind ------------
  //
  // TODO.md #53: label lookups were seen flipping between hit and miss on
  // consecutive identical calls while a modal was up, and the suspicion is the
  // frontmost application changing under the read. Only one of these two
  // changes the frontmost *process*, which is what makes the pair worth having:
  //
  //   In-app  — UIAlertController, presented by this app, in this process.
  //   System  — the notification permission alert, drawn by a separate process
  //             that becomes frontmost while it is up (TODO.md #37).
  //
  // Both are raised on demand, so a reproduction no longer depends on catching
  // Photos mid-wizard with a permission prompt racing it.
  UIButton *inAppModal = [UIButton buttonWithType:UIButtonTypeSystem];
  [inAppModal setTitle:@"Show In-App Modal" forState:UIControlStateNormal];
  [inAppModal addTarget:self
                 action:@selector(showInAppModal)
       forControlEvents:UIControlEventTouchUpInside];
  inAppModal.accessibilityIdentifier = @"InAppModalButton";

  UIButton *systemModal = [UIButton buttonWithType:UIButtonTypeSystem];
  [systemModal setTitle:@"Ask Permission" forState:UIControlStateNormal];
  [systemModal addTarget:self
                  action:@selector(askNotificationPermission)
        forControlEvents:UIControlEventTouchUpInside];
  systemModal.accessibilityIdentifier = @"SystemModalButton";

  // --- One of each control kind, for the type vocabulary --------------------
  //
  // TODO.md #58: the same element is described with a different `type`
  // depending on which tool asked, because the whole-screen read and the point
  // read are served by different accessibility backends. A UIButton is called
  // "Button" by both, so the fixture could not show the problem at all. These
  // are the kinds whose names plausibly differ; each is here to be looked up
  // twice and have the two answers compared, not to be interacted with.
  UISearchBar *searchBar = [[UISearchBar alloc] init];
  searchBar.placeholder = @"Search Bar";
  searchBar.accessibilityIdentifier = @"SearchBar";

  UISwitch *toggle = [[UISwitch alloc] init];
  toggle.accessibilityLabel = @"Plain Switch";
  toggle.accessibilityIdentifier = @"PlainSwitch";

  UISlider *slider = [[UISlider alloc] init];
  slider.accessibilityLabel = @"Plain Slider";
  slider.accessibilityIdentifier = @"PlainSlider";

  UIStepper *stepper = [[UIStepper alloc] init];
  stepper.accessibilityLabel = @"Plain Stepper";
  stepper.accessibilityIdentifier = @"PlainStepper";

  UISegmentedControl *segmented =
      [[UISegmentedControl alloc] initWithItems:@[ @"Seg One", @"Seg Two" ]];
  segmented.selectedSegmentIndex = 0;
  segmented.accessibilityIdentifier = @"PlainSegmented";

  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:@[
    self.plainField, plainButton, self.status, self.orientation, inAppModal,
    systemModal, searchBar, toggle, slider, stepper, segmented
  ]];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 24;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];

  UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [stack.topAnchor constraintEqualToAnchor:safe.topAnchor constant:40],
    [stack.centerXAnchor constraintEqualToAnchor:safe.centerXAnchor],
    [stack.widthAnchor constraintEqualToConstant:280],
  ]];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  // The window is not attached in viewDidLoad, and the interface orientation
  // comes from its scene.
  [self refreshOrientation];
}

- (void)viewWillTransitionToSize:(CGSize)size
       withTransitionCoordinator:
           (id<UIViewControllerTransitionCoordinator>)coordinator {
  [super viewWillTransitionToSize:size withTransitionCoordinator:coordinator];
  [coordinator
      animateAlongsideTransition:nil
                      completion:^(
                          id<UIViewControllerTransitionCoordinatorContext> ctx) {
                        [self refreshOrientation];
                      }];
}

- (void)refreshOrientation {
  UIInterfaceOrientation interface =
      self.view.window.windowScene.interfaceOrientation;
  self.orientation.text = [NSString
      stringWithFormat:@"orientation: interface=%@ device=%@",
                       InterfaceOrientationName(interface),
                       DeviceOrientationName(UIDevice.currentDevice.orientation)];
}

- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [UIDevice.currentDevice endGeneratingDeviceOrientationNotifications];
}

- (UITextField *)fieldWithPlaceholder:(NSString *)placeholder
                           identifier:(NSString *)identifier {
  UITextField *field = [[UITextField alloc] init];
  field.placeholder = placeholder;
  field.borderStyle = UITextBorderStyleRoundedRect;
  field.autocorrectionType = UITextAutocorrectionTypeNo;
  field.autocapitalizationType = UITextAutocapitalizationTypeNone;
  field.accessibilityIdentifier = identifier;
  field.delegate = self;
  [field addTarget:self
                action:@selector(fieldChanged:)
      forControlEvents:UIControlEventEditingChanged];
  return field;
}

#pragma mark - Actions

- (void)report:(NSString *)text {
  self.status.text = [@"status: " stringByAppendingString:text];
  NSLog(@"MCPTestApp: %@", text);
}

- (void)navButtonTapped {
  [self report:@"tapped Nav Button"];
}
- (void)toolbarButtonTapped {
  [self report:@"tapped Toolbar Button"];
}
- (void)plainButtonTapped {
  [self report:@"tapped Plain Button"];
}

/// An alert in this app's own process. The frontmost application does not change.
- (void)showInAppModal {
  UIAlertController *alert = [UIAlertController
      alertControllerWithTitle:@"In-App Modal"
                       message:@"Presented by the app itself."
                preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"Modal OK"
                                            style:UIAlertActionStyleDefault
                                          handler:^(UIAlertAction *a) {
                                            [self report:@"dismissed In-App Modal"];
                                          }]];
  [self presentViewController:alert animated:YES completion:nil];
  [self report:@"showing In-App Modal"];
}

/// The system permission alert, drawn by another process which becomes
/// frontmost while it is up. Only ever appears once per install.
- (void)askNotificationPermission {
  [self report:@"asking for notification permission"];
  [UNUserNotificationCenter.currentNotificationCenter
      requestAuthorizationWithOptions:UNAuthorizationOptionAlert
                    completionHandler:^(BOOL granted, NSError *error) {
                      dispatch_async(dispatch_get_main_queue(), ^{
                        [self report:[NSString
                                         stringWithFormat:@"permission granted=%@",
                                                          granted ? @"YES" : @"NO"]];
                      });
                    }];
}

- (void)fieldChanged:(UITextField *)field {
  NSString *which =
      field == self.toolbarField ? @"Toolbar Search" : @"Plain Field";
  [self report:[NSString stringWithFormat:@"%@ = \"%@\"", which, field.text]];
}

- (BOOL)textFieldShouldReturn:(UITextField *)field {
  [field resignFirstResponder];
  return YES;
}

@end

#pragma mark - Lifecycle

@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation SceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)options {
  if (![scene isKindOfClass:UIWindowScene.class]) return;

  // A UINavigationController rather than hand-placed bars, so the nav bar and
  // toolbar are the real UIKit ones — the fixture is only worth anything if
  // its chrome is the same chrome that fails in Contacts and Photos.
  UINavigationController *nav = [[UINavigationController alloc]
      initWithRootViewController:[[RootViewController alloc] init]];
  nav.toolbarHidden = NO;

  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = nav;
  [self.window makeKeyAndVisible];
}

@end

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil,
                             NSStringFromClass(AppDelegate.class));
  }
}
