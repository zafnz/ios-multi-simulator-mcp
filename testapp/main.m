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

#pragma mark - Root view controller

@interface RootViewController : UIViewController <UITextFieldDelegate>
@property(nonatomic, strong) UILabel *status;
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

  UIStackView *stack = [[UIStackView alloc]
      initWithArrangedSubviews:@[ self.plainField, plainButton, self.status ]];
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
