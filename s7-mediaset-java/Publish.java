import com.scene7.api.webserviceclient.*;

// Submit an Image Serving publish job. args: server user pass company publishType
public class Publish {
    public static void main(String[] args) throws Exception {
        String server=args[0], user=args[1], pass=args[2], company=args[3];
        String publishType = args.length>4 ? args[4] : "incremental";

        IpsApiServiceStub stub = new IpsApiServiceStub(server.endsWith("/")?server:server+"/");
        AuthHeader auth = new AuthHeader();
        auth.setUser(user); auth.setPassword(pass);
        auth.setAppName("fanout-demo"); auth.setAppVersion("1.0.0");

        ImageServingPublishJob pj = new ImageServingPublishJob();
        pj.setPublishType(publishType);
        pj.setEmailSetting(args.length>5 ? args[5] : "none");

        SubmitJobParam p = new SubmitJobParam();
        p.setCompanyHandle(company);
        p.setJobName("fanout-demo publish " + System.currentTimeMillis());
        p.setImageServingPublishJob(pj);

        try {
            SubmitJobReturn r = stub.submitJob(p, auth);
            System.out.println("PUBLISH SUBMITTED jobHandle=" + r.getJobHandle() + " (type=" + publishType + ")");
        } catch (IpsApiFaultException e) {
            IpsApiFault f = e.getFaultMessage();
            System.out.println("FAULT code=" + (f!=null?f.getCode():"?") + " reason=" + (f!=null?f.getReason():e.getMessage()));
        }
    }
}
